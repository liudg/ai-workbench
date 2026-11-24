import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import type { createRoot as CreateRoot, Root } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";

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
installGlobal("fetch", () =>
  Promise.resolve(
    new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
  ),
);

let server: ViteDevServer;
let createRoot: typeof CreateRoot;
let daemonMod: typeof import("../../../lib/daemon/index.ts");
let visibilityMod: typeof import("../../../shared/shell/sidebar-open.ts");
let navigationMod: typeof import("../../../shared/shell/navigation.ts");
let sidebarMod: typeof import("../Sidebar.tsx");

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
  visibilityMod = (await server.ssrLoadModule(
    "/src/shared/shell/sidebar-open.ts",
  )) as typeof visibilityMod;
  navigationMod = (await server.ssrLoadModule(
    "/src/shared/shell/navigation.ts",
  )) as typeof navigationMod;
  sidebarMod = (await server.ssrLoadModule("/src/features/sidebar/Sidebar.tsx")) as typeof sidebarMod;
});

after(async () => {
  daemonMod?.daemon.stop();
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

function setInputValue(input: { dispatchEvent: (event: InstanceType<typeof dom.InputEvent>) => boolean }, value: string) {
  const protoSetter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set;
  protoSetter?.call(input, value);
  input.dispatchEvent(new dom.InputEvent("input", { bubbles: true }));
}

test("sidebar persistent inline search debounces tasks.search, toggles 含已归档, renders safe <mark> highlights, and jumps via keyboard/click", async () => {
  const originalCall = daemonMod.daemon.call;
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as HTMLElement);

  try {
    visibilityMod.setSidebarOpen(true);
    daemonMod.startPreview({
      [daemonMod.TOPIC_PROJECTS]: [
        {
          id: "proj-1",
          name: "核心仓库",
          path: "/work/core",
          folders: ["/work/core"],
          pinned: false,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      [daemonMod.TOPIC_TASKS]: [
        {
          id: "task-1",
          projectId: "proj-1",
          title: "修登录跳转",
          workspace: { kind: "root" },
          pinned: false,
          createdAt: 1,
          updatedAt: 2,
          sessions: [],
          attention: { state: "idle", unread: false, updatedAt: 2 },
        },
        {
          id: "chat-standalone",
          title: "随手记一句",
          workspace: { kind: "root" },
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
          sessions: [],
          attention: { state: "idle", unread: false, updatedAt: 1 },
        },
      ],
      [daemonMod.TOPIC_AGENT_CATALOGS]: [],
    });

    const searchCalls: unknown[] = [];
    daemonMod.daemon.call = (async (method: string, params: unknown) => {
      if (method === "tasks.search") {
        searchCalls.push(params);
        const queryParams = params as { query: string; includeArchived?: boolean; limit?: number };
        if (queryParams.query === "空结果") return [];
        const base = [
          {
            taskId: "task-1",
            projectId: "proj-1",
            taskTitle: "修登录跳转",
            sessionId: "s-1",
            eventId: "ev-101",
            seq: 10,
            role: "assistant",
            snippet: "在 [[认证模块]] 修复了 <img src=x onerror=alert(1)> 登录 token 报错",
            ts: 100,
          },
          {
            taskId: "chat-standalone",
            taskTitle: "随手记一句",
            sessionId: "s-2",
            eventId: "ev-202",
            seq: 3,
            role: "user",
            snippet: "登录接口超时怎么排查",
            ts: 90,
          },
        ];
        if (queryParams.includeArchived) {
          base.push({
            taskId: "task-archived",
            projectId: "proj-1",
            taskTitle: "旧版登录方案",
            archivedAt: 80,
            sessionId: "s-3",
            eventId: "ev-303",
            seq: 5,
            role: "title",
            snippet: "旧版登录方案",
            ts: 80,
          } as (typeof base)[number] & { archivedAt: number });
        }
        return base;
      }
      return null;
    }) as typeof daemonMod.daemon.call;

    function NavStatus() {
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
      root.render(createElement("div", null, createElement(sidebarMod.Sidebar), createElement(NavStatus)));
    });

    const input = dom.document.querySelector("[data-sidebar-search-input]");
    assert.ok(input instanceof dom.HTMLInputElement);
    assert.equal(input.getAttribute("placeholder"), "搜索全部会话与消息…");
    assert.ok(dom.document.querySelector("[data-sidebar-section='chats']"));

    // 侧栏内部按下 Ctrl+F 时聚焦搜索框
    const newChatBtn = dom.document.querySelector("[data-new-chat-entry] button, [data-new-chat-entry]");
    assert.ok(newChatBtn instanceof dom.HTMLElement);
    newChatBtn.focus();
    await act(async () => {
      newChatBtn.dispatchEvent(
        new dom.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    assert.equal(dom.document.activeElement, input as unknown);

    // 防抖：快速连续输入两次，只应为最新词发出一次请求
    await act(async () => {
      setInputValue(input, "草稿");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      setInputValue(input, "  登录 token  ");
    });
    assert.equal(searchCalls.length, 0);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });

    assert.deepEqual(searchCalls, [
      { query: "登录 token", includeArchived: false, limit: 40 },
    ]);

    // 原项目树与独立聊天组已被搜索结果原地替换
    assert.equal(dom.document.querySelector("[data-sidebar-section='chats']"), null);
    const hits = Array.from(dom.document.querySelectorAll("[data-sidebar-search-hit]"));
    assert.equal(hits.length, 2);

    // 校验项目徽章、角色标签、字面量 [[ ]] 与零 XSS <mark> 高亮
    assert.equal(hits[0]?.querySelector("[data-search-hit-project]")?.textContent, "核心仓库");
    assert.equal(hits[0]?.querySelector("[data-search-hit-role]")?.textContent, "助手");
    assert.equal(hits[0]?.querySelector("img"), null);
    const marks0 = Array.from(hits[0]!.querySelectorAll("mark")).map((el) => el.textContent);
    assert.deepEqual(marks0, ["登录", "登录", "token"]);
    assert.equal(hits[0]?.textContent?.includes("[[认证模块]]"), true);

    assert.equal(hits[1]?.querySelector("[data-search-hit-project]")?.textContent, "聊天");
    assert.equal(hits[1]?.querySelector("[data-search-hit-role]")?.textContent, "用户");

    // 切换「含已归档」胶囊
    const archivedToggle = dom.document.querySelector("[data-sidebar-search-archived]");
    assert.ok(archivedToggle instanceof dom.HTMLButtonElement);
    assert.equal(archivedToggle.getAttribute("aria-pressed"), "false");
    await act(async () => {
      archivedToggle.click();
    });
    assert.equal(archivedToggle.getAttribute("aria-pressed"), "true");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    assert.deepEqual(searchCalls[1], {
      query: "登录 token",
      includeArchived: true,
      limit: 40,
    });
    const hitsWithArchived = Array.from(dom.document.querySelectorAll("[data-sidebar-search-hit]"));
    assert.equal(hitsWithArchived.length, 3);
    assert.equal(
      hitsWithArchived[2]?.querySelector("[data-search-hit-archived]")?.textContent,
      "已归档",
    );
    // role === "title" hit must NOT render a duplicate secondary snippet line underneath the title
    assert.equal(hitsWithArchived[0]?.querySelectorAll(".line-clamp-2").length, 1);
    assert.equal(hitsWithArchived[2]?.querySelectorAll(".line-clamp-2").length, 0);

    // 键盘 ArrowDown + Enter 跳转到第 2 条命中并携带 eventId + query
    await act(async () => {
      input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    assert.equal(hitsWithArchived[1]?.getAttribute("data-active"), "true");

    await act(async () => {
      input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const navAfterEnter = JSON.parse(host.querySelector("output")!.textContent!);
    assert.deepEqual(navAfterEnter.view, {
      kind: "task",
      taskId: "chat-standalone",
      projectId: null,
    });
    assert.equal(navAfterEnter.pendingJump?.taskId, "chat-standalone");
    assert.equal(navAfterEnter.pendingJump?.eventId, "ev-202");
    assert.equal(navAfterEnter.pendingJump?.query, "登录 token");

    // 空结果文案
    await act(async () => {
      setInputValue(input, "空结果");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    assert.equal(
      dom.document.querySelector("[data-sidebar-search-empty]")?.textContent,
      "未找到匹配的会话或消息",
    );

    // Escape 清空查询并恢复普通项目与会话树
    await act(async () => {
      input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(input.value, "");
    assert.equal(dom.document.querySelector("[data-sidebar-search-results]"), null);
    assert.ok(dom.document.querySelector("[data-sidebar-section='chats']"));
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    daemonMod.daemon.call = originalCall;
  }
});

test("sidebar search ignores stale out-of-order responses and clears via × button", async () => {
  const originalCall = daemonMod.daemon.call;
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as HTMLElement);

  try {
    visibilityMod.setSidebarOpen(true);
    let resolveSlowFirst: ((hits: unknown[]) => void) | null = null;
    daemonMod.daemon.call = (async (method: string, params: unknown) => {
      if (method === "tasks.search") {
        const { query } = params as { query: string };
        if (query === "慢请求") {
          return await new Promise<unknown[]>((resolve) => {
            resolveSlowFirst = resolve;
          });
        }
        return [
          {
            taskId: "fast-hit",
            projectId: "proj-1",
            taskTitle: "快请求结果",
            role: "user",
            snippet: "快请求命中的最新消息",
            ts: 200,
          },
        ];
      }
      return null;
    }) as typeof daemonMod.daemon.call;

    await act(async () => {
      root.render(createElement(sidebarMod.Sidebar));
    });

    const input = dom.document.querySelector("[data-sidebar-search-input]");
    assert.ok(input instanceof dom.HTMLInputElement);
    await act(async () => {
      setInputValue(input, "慢请求");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    assert.ok(resolveSlowFirst);

    await act(async () => {
      setInputValue(input, "快请求");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    assert.equal(
      dom.document.querySelector("[data-sidebar-search-hit]")?.getAttribute("data-sidebar-search-hit"),
      "fast-hit",
    );

    // 迟到的旧请求返回时不得覆盖新结果
    await act(async () => {
      resolveSlowFirst?.([
        {
          taskId: "stale-hit",
          projectId: "proj-1",
          taskTitle: "过期结果",
          role: "user",
          snippet: "不应显示的旧结果",
          ts: 100,
        },
      ]);
    });
    assert.equal(
      dom.document.querySelector("[data-sidebar-search-hit]")?.getAttribute("data-sidebar-search-hit"),
      "fast-hit",
    );

    // 点击 × 清空按钮重置并保持聚焦
    const clearBtn = dom.document.querySelector("[data-sidebar-search-clear]");
    assert.ok(clearBtn instanceof dom.HTMLButtonElement);
    await act(async () => {
      clearBtn.click();
    });
    assert.equal(input.value, "");
    assert.equal(dom.document.querySelector("[data-sidebar-search-results]"), null);
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    daemonMod.daemon.call = originalCall;
  }
});
