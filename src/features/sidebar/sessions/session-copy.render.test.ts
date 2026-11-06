import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer } from "vite";

test("both session menu entry points copy the target task without opening it, and report failures", async () => {
  const dom = new Window({ url: "http://localhost/" });
  const globals = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    SVGElement: dom.SVGElement,
    MutationObserver: dom.MutationObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const clipboard: string[] = [];
  Object.defineProperty(dom.navigator, "clipboard", { value: { writeText: async (text: string) => { clipboard.push(text); } } });
  const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
  const server = await createServer({ root: rootDir, server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const { daemon } = await server.ssrLoadModule("/src/lib/daemon/index.ts") as typeof import("../../../lib/daemon/index.ts");
  const originalCall = daemon.call;
  try {
    const agents = await server.ssrLoadModule("/src/features/agents/index.ts");
    agents.seedAgents({}, []);
    const { SessionRow } = await server.ssrLoadModule("/src/features/sidebar/sessions/SessionRow.tsx") as typeof import("./SessionRow.tsx");
    const navigation = await server.ssrLoadModule("/src/shared/shell/navigation.ts") as typeof import("../../../shared/shell/navigation.ts");
    const notices = await server.ssrLoadModule("/src/features/sidebar/sidebar-notice.ts") as typeof import("../sidebar-notice.ts");
    const errors = await server.ssrLoadModule("/src/shared/shell/error-banner.ts") as typeof import("../../../shared/shell/error-banner.ts");
    const calls: { method: string; params: unknown }[] = [];
    let fail = false;
    daemon.call = (async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (fail) throw new Error("无法读取会话");
      if (method === "tasks.workdir") return "C:\\项目\\工作树";
      if (method === "tasks.exportMarkdown") return "# 历史\n\n## 用户\n\n完整正文\n";
      throw new Error(`Unexpected call: ${method}`);
    }) as typeof daemon.call;
    navigation.openTask("currently-open", "p");
    function Status() {
      return createElement("output", null, JSON.stringify({
        view: navigation.useNavigation((state) => state.view),
        notice: notices.useSidebarNotice(),
        error: errors.useErrorBanner(),
      }));
    }
    await act(async () => root.render(createElement("div", null,
      createElement(SessionRow, {
        task: { id: "right-clicked", projectId: "p", title: "另一个会话", agent: undefined, status: undefined,
          attention: { state: "done", unread: false, updatedAt: 1 }, updatedAt: 1, pinned: false, archived: true, parentTaskId: null },
        active: false, now: 1, depth: 0, subtasks: 0, collapsed: false, onToggle: () => {},
      }), createElement(Status))));
    const click = async (selector: string) => {
      const button = dom.document.querySelector(selector);
      assert.ok(button instanceof dom.HTMLButtonElement, selector);
      await act(async () => button.click());
    };
    const status = () => JSON.parse(host.querySelector("output")!.textContent);
    await act(async () => {
      host.querySelector("[data-session-row]")!.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await click('[data-session-action="copy"]');
    await click('[data-session-action="copy-workdir"]');
    assert.deepEqual(clipboard, ["C:\\项目\\工作树"]);
    assert.equal(status().notice, "已复制工作目录");
    assert.equal(dom.document.querySelector('[role="menu"]'), null);
    await click('button[aria-label="聊天操作"]');
    await click('[data-session-action="copy"]');
    await click('[data-session-action="copy-markdown"]');
    assert.equal(clipboard[1], "# 历史\n\n## 用户\n\n完整正文\n");
    assert.equal(status().notice, "已复制为 Markdown");
    assert.deepEqual(calls, [
      { method: "tasks.workdir", params: { id: "right-clicked" } },
      { method: "tasks.exportMarkdown", params: { id: "right-clicked" } },
    ]);
    fail = true;
    await click('button[aria-label="聊天操作"]');
    await click('[data-session-action="copy"]');
    await click('[data-session-action="copy-markdown"]');
    assert.equal(clipboard.length, 2);
    assert.equal(status().error, "无法读取会话");
    assert.equal(status().view.taskId, "currently-open");
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    daemon.call = originalCall;
    daemon.stop();
    await server.close();
    await dom.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
