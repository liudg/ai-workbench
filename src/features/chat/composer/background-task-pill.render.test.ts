import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import type { SessionEvent, SessionEventBody } from "../../../types/index.ts";
import { backgroundTasks, toolCallsByStreamId } from "../events/background-task-display.ts";

const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
const dom = new Window({ url: "http://localhost/" });
const installed: PropertyKey[] = [];

function installGlobal(key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (descriptor && !descriptor.configurable && !descriptor.writable) return;
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  installed.push(key);
}

installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
installGlobal("window", dom);
installGlobal("document", dom.document);
installGlobal("HTMLElement", dom.HTMLElement);
installGlobal("Element", dom.Element);
installGlobal("Node", dom.Node);
installGlobal("navigator", dom.navigator);
installGlobal("MutationObserver", dom.MutationObserver);
installGlobal("ResizeObserver", dom.ResizeObserver);
installGlobal("getComputedStyle", dom.getComputedStyle.bind(dom));
installGlobal("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
installGlobal("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));

let server: ViteDevServer;
let BackgroundTaskPill: typeof import("./BackgroundTaskPill.tsx").BackgroundTaskPill;
let useBackgroundPill: typeof import("./BackgroundTaskPill.tsx").useBackgroundPill;

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  const mod = await server.ssrLoadModule("/src/features/chat/composer/BackgroundTaskPill.tsx");
  BackgroundTaskPill = mod.BackgroundTaskPill;
  useBackgroundPill = mod.useBackgroundPill;
});

after(async () => {
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

function ev(id: string, seq: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq, ts: seq * 1_000, ...body };
}

test("pill stays hidden when idle, pins tasks started while open, resets on empty events, and avoids duplicate output reads", async () => {
  const stopped: string[] = [];
  let readCalls = 0;
  const hostEl = document.createElement("div");
  document.body.appendChild(hostEl);
  const root = createRoot(hostEl);

  function Harness({
    events,
    canStop,
    rerenderTick = 0,
  }: {
    events: SessionEvent[];
    canStop: boolean;
    rerenderTick?: number;
  }) {
    const tasks = backgroundTasks(events);
    const pill = useBackgroundPill(tasks);
    return createElement(BackgroundTaskPill, {
      pill,
      toolsByStream: toolCallsByStreamId(events),
      projectPath: "",
      canStop,
      onStop: async (id) => {
        stopped.push(id);
      },
      // 模拟每次渲染都创建新闭包，验证 useBackgroundOutput 不会重复触发读取
      readTaskOutput: async (path) => {
        readCalls += 1;
        return `file-out:${path}:${rerenderTick}`;
      },
    });
  }

  // 1) 已结束任务不展示胶囊
  await act(async () => {
    root.render(
      createElement(Harness, {
        canStop: true,
        events: [
          ev("b0", 1, {
            kind: "background-task",
            task_id: "t0",
            task_type: "terminal",
            title: "ls",
            status: "completed",
          }),
        ],
      }),
    );
  });
  assert.equal(hostEl.querySelector("[data-background-pill]"), null);

  // 2) 单任务运行中显示标题，点击展开气泡看到关联工具输出与停止按钮
  const task1Done = ev("b1", 2, {
    kind: "background-task",
    task_id: "t1",
    task_type: "local_bash",
    tool_call_id: "call_1",
    title: "后台监听构建产物",
    output_file: "/tmp/t1.out",
    status: "completed",
  });
  const task1Running = ev("b1", 2, {
    kind: "background-task",
    task_id: "t1",
    task_type: "local_bash",
    tool_call_id: "call_1",
    title: "后台监听构建产物",
    status: "running",
    started_at: Date.now() - 5_000,
  });
  const liveEvents: SessionEvent[] = [
    ev("c1", 1, {
      kind: "tool-call",
      name: "Bash",
      summary: "sleep 300 && echo BG-DONE",
      detail: "Command running in background with ID: t1.",
      stream_id: "call_1",
      status: "completed",
    }),
    task1Running,
  ];

  await act(async () => {
    root.render(createElement(Harness, { canStop: true, events: liveEvents }));
  });
  const pill = hostEl.querySelector<HTMLButtonElement>("[data-background-pill]");
  assert.ok(pill);
  assert.match(pill.textContent ?? "", /后台监听构建产物/);
  assert.equal(pill.getAttribute("aria-label"), "后台任务：后台监听构建产物");

  await act(async () => {
    pill.click();
  });
  const pop = document.querySelector("[data-background-popover]");
  assert.ok(pop);
  assert.match(pop.textContent ?? "", /sleep 300 && echo BG-DONE/);

  const stopBtn = document.querySelector<HTMLButtonElement>('[data-background-stop="t1"]');
  assert.ok(stopBtn);
  await act(async () => {
    stopBtn.click();
  });
  assert.deepEqual(stopped, ["t1"]);

  // 3) 气泡打开期间新启动的任务 t2 停止后仍保留在气泡列表里
  const withSecondRunning: SessionEvent[] = [
    ...liveEvents,
    ev("b2", 3, {
      kind: "background-task",
      task_id: "t2",
      task_type: "terminal",
      title: "pnpm dev",
      status: "running",
    }),
  ];
  await act(async () => {
    root.render(createElement(Harness, { canStop: true, events: withSecondRunning }));
  });
  await act(async () => {
    root.render(
      createElement(Harness, {
        canStop: true,
        events: [
          liveEvents[0],
          task1Done,
          ev("b2_stop", 4, {
            kind: "background-task",
            task_id: "t2",
            task_type: "terminal",
            title: "pnpm dev",
            status: "stopped",
          }),
        ],
        rerenderTick: 1,
      }),
    );
  });
  const row2Toggle = document.querySelector<HTMLButtonElement>('[data-background-row="t2"] button');
  assert.ok(row2Toggle);
  assert.equal(row2Toggle.disabled, true, "无展开内容的已停止任务行不可点击");
  const readsAfterDone = readCalls;
  await act(async () => {
    root.render(
      createElement(Harness, {
        canStop: true,
        events: [liveEvents[0], task1Done],
        rerenderTick: 2,
      }),
    );
  });
  assert.equal(readCalls, readsAfterDone, "重渲染创建新 readTaskOutput 闭包不会重复读已结束文件");

  // 4) 事件清空后再来已结束任务，不会残留假打开态或孤立「后台任务已结束」胶囊
  await act(async () => {
    root.render(createElement(Harness, { canStop: true, events: [] }));
  });
  assert.equal(hostEl.querySelector("[data-background-pill]"), null);
  await act(async () => {
    root.render(createElement(Harness, { canStop: true, events: [task1Done] }));
  });
  assert.equal(hostEl.querySelector("[data-background-pill]"), null);

  // 5) 不支持单独停止时隐藏停止按钮
  await act(async () => {
    root.render(createElement(Harness, { canStop: false, events: liveEvents }));
  });
  assert.equal(document.querySelector('[data-background-stop="t1"]'), null);

  await act(async () => {
    root.unmount();
  });
  hostEl.remove();
});
