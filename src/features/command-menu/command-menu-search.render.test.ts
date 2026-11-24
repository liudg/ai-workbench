import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import type { createRoot as CreateRoot, Root } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
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
installGlobal("navigator", dom.navigator);
installGlobal("HTMLElement", dom.HTMLElement);
installGlobal("HTMLButtonElement", dom.HTMLButtonElement);
installGlobal("HTMLInputElement", dom.HTMLInputElement);
installGlobal("Element", dom.Element);
installGlobal("Node", dom.Node);
installGlobal("SVGElement", dom.SVGElement);
installGlobal("Event", dom.Event);
installGlobal("CustomEvent", dom.CustomEvent);
installGlobal("InputEvent", dom.InputEvent);
installGlobal("KeyboardEvent", dom.KeyboardEvent);
installGlobal("MouseEvent", dom.MouseEvent);
installGlobal("MutationObserver", dom.MutationObserver);
installGlobal("getComputedStyle", dom.getComputedStyle.bind(dom));
installGlobal("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
installGlobal("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));

let server: ViteDevServer;
let createRoot: typeof CreateRoot;
let daemonMod: typeof import("../../lib/daemon/index.ts");
let navigationMod: typeof import("../../shared/shell/navigation.ts");
let commandMenuMod: typeof import("./index.ts");

before(async () => {
  ({ createRoot } = await import("react-dom/client"));
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    logLevel: "error",
  });
  const agentsMod = await server.ssrLoadModule("/src/features/agents/index.ts");
  agentsMod.seedAgents({}, []);
  daemonMod = (await server.ssrLoadModule("/src/lib/daemon/index.ts")) as typeof daemonMod;
  navigationMod = (await server.ssrLoadModule(
    "/src/shared/shell/navigation.ts",
  )) as typeof navigationMod;
  commandMenuMod = (await server.ssrLoadModule(
    "/src/features/command-menu/index.ts",
  )) as typeof commandMenuMod;
});

after(async () => {
  daemonMod?.daemon.stop();
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

test("CommandMenuHost renders async full-text 会话正文命中 hits and jumps to matched eventId on selection", async () => {
  const originalCall = daemonMod.daemon.call;
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as HTMLElement);

  try {
    daemonMod.startPreview({
      [daemonMod.TOPIC_PROJECTS]: [
        {
          id: "proj-alpha",
          name: "后端引擎",
          path: "/work/alpha",
          folders: ["/work/alpha"],
          pinned: false,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      [daemonMod.TOPIC_TASKS]: [
        {
          id: "task-alpha",
          projectId: "proj-alpha",
          title: "排查数据库连接池",
          workspace: { kind: "root" },
          pinned: false,
          createdAt: 1,
          updatedAt: 2,
          sessions: [],
          attention: { state: "idle", unread: false, updatedAt: 2 },
        },
      ],
      [daemonMod.TOPIC_AGENT_CATALOGS]: [],
    });

    const searchCalls: unknown[] = [];
    daemonMod.daemon.call = (async (method: string, params: unknown) => {
      if (method === "tasks.search") {
        searchCalls.push(params);
        return [
          {
            taskId: "task-alpha",
            projectId: "proj-alpha",
            taskTitle: "排查数据库连接池",
            archivedAt: 50,
            sessionId: "sess-alpha",
            eventId: "event-deadlock-9",
            seq: 9,
            role: "assistant",
            snippet: "连接池在高并发下触发了 deadlock 超时回滚",
            ts: 120,
          },
        ];
      }
      return null;
    }) as typeof daemonMod.daemon.call;

    function NavProbe() {
      return createElement(
        "output",
        null,
        JSON.stringify({
          view: navigationMod.useNavigation((s) => s.view),
          pendingJump: navigationMod.useNavigation((s) => s.pendingJump),
        }),
      );
    }

    await act(async () => {
      root.render(
        createElement("div", null, createElement(commandMenuMod.CommandMenuHost), createElement(NavProbe)),
      );
    });

    await act(async () => {
      commandMenuMod.openCommandMenu();
    });

    const queryInput = dom.document.querySelector("[data-command-query]");
    assert.ok(queryInput instanceof dom.HTMLInputElement);

    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(queryInput, "deadlock 超时");
      queryInput.dispatchEvent(new dom.InputEvent("input", { bubbles: true }));
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });

    assert.deepEqual(searchCalls, [
      { query: "deadlock 超时", includeArchived: true, limit: 20 },
    ]);

    const messageSection = dom.document.querySelector('[data-command-menu-search-section="messages"]');
    assert.ok(messageSection);
    assert.equal(messageSection.querySelector("h2")?.textContent, "会话正文命中");

    const hitRow = messageSection.querySelector('[data-command-row-kind="message"]');
    assert.ok(hitRow instanceof dom.HTMLButtonElement);
    assert.equal(hitRow.getAttribute("data-command-row"), "task-alpha");
    assert.equal(hitRow.getAttribute("data-command-event-id"), "event-deadlock-9");
    assert.equal(hitRow.querySelector("[data-command-hit-project]")?.textContent, "后端引擎");
    assert.equal(hitRow.querySelector("[data-command-hit-archived]")?.textContent, "已归档");
    assert.equal(hitRow.querySelector("[data-command-hit-role]")?.textContent, "助手");
    const marks = Array.from(hitRow.querySelectorAll("mark")).map((el) => el.textContent);
    assert.deepEqual(marks, ["deadlock", "超时"]);

    // 回车或点击该命中：关闭命令面板并带 eventId + query 跳转到对应任务消息
    await act(async () => {
      queryInput.dispatchEvent(
        new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    assert.equal(dom.document.querySelector("[data-command-menu]"), null);
    const nav = JSON.parse(host.querySelector("output")!.textContent!);
    assert.deepEqual(nav.view, {
      kind: "task",
      taskId: "task-alpha",
      projectId: "proj-alpha",
    });
    assert.equal(nav.pendingJump?.taskId, "task-alpha");
    assert.equal(nav.pendingJump?.eventId, "event-deadlock-9");
    assert.equal(nav.pendingJump?.query, "deadlock 超时");

    // Sidebar collapsed / unmounted: Mod+1 works on the VERY FIRST keypress directly from tasks/projects state!
    await act(async () => {
      navigationMod.openNewSession(null);
    });
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.KeyboardEvent("keydown", {
          key: "1",
          code: "Digit1",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const navAfterJump1 = JSON.parse(host.querySelector("output")!.textContent!);
    assert.deepEqual(navAfterJump1.view, {
      kind: "task",
      taskId: "task-alpha",
      projectId: "proj-alpha",
    });

    // When `[data-sidebar-search-results]` is visible in the DOM, Mod+1..9 must NOT jump to hidden tree sessions!
    await act(async () => {
      navigationMod.openNewSession(null);
    });
    const fakeSidebarResults = dom.document.createElement("div");
    fakeSidebarResults.setAttribute("data-sidebar-search-results", "");
    dom.document.body.appendChild(fakeSidebarResults);
    try {
      await act(async () => {
        dom.window.dispatchEvent(
          new dom.KeyboardEvent("keydown", {
            key: "1",
            code: "Digit1",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      const navWhileSearching = JSON.parse(host.querySelector("output")!.textContent!);
      assert.equal(navWhileSearching.view.kind, "new");
    } finally {
      fakeSidebarResults.remove();
    }
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    daemonMod.daemon.call = originalCall;
  }
});
