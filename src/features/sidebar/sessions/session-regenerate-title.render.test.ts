import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer } from "vite";

test("session context menu AI 重新生成标题 calls tasks.regenerateTitle with busy state and surfaces failures via error banner", async () => {
  const dom = new Window({ url: "http://localhost/" });
  const globals = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    Element: dom.Element,
    Node: dom.Node,
    SVGElement: dom.SVGElement,
    MutationObserver: dom.MutationObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
  const server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    logLevel: "error",
  });
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const { daemon } = (await server.ssrLoadModule(
    "/src/lib/daemon/index.ts",
  )) as typeof import("../../../lib/daemon/index.ts");
  const originalCall = daemon.call;

  try {
    const agents = await server.ssrLoadModule("/src/features/agents/index.ts");
    agents.seedAgents({}, []);
    const { SessionRow } = (await server.ssrLoadModule(
      "/src/features/sidebar/sessions/SessionRow.tsx",
    )) as typeof import("./SessionRow.tsx");
    const navigation = (await server.ssrLoadModule(
      "/src/shared/shell/navigation.ts",
    )) as typeof import("../../../shared/shell/navigation.ts");
    const errors = (await server.ssrLoadModule(
      "/src/shared/shell/error-banner.ts",
    )) as typeof import("../../../shared/shell/error-banner.ts");

    errors.clearError();
    navigation.openTask("active-session", "p1");

    const calls: { method: string; params: unknown }[] = [];
    let resolvePending: ((value: { title: string }) => void) | null = null;
    let shouldFail = false;

    daemon.call = (async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "tasks.regenerateTitle") {
        if (shouldFail) throw new Error("轻量模型生成标题失败");
        return await new Promise<{ title: string }>((resolve) => {
          resolvePending = resolve;
        });
      }
      throw new Error(`Unexpected daemon call: ${method}`);
    }) as typeof daemon.call;

    function Status() {
      return createElement(
        "output",
        null,
        JSON.stringify({
          view: navigation.useNavigation((state) => state.view),
          error: errors.useErrorBanner(),
        }),
      );
    }

    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(SessionRow, {
            task: {
              id: "target-session",
              projectId: "p1",
              title: "新会话",
              agent: undefined,
              status: undefined,
              attention: { state: "done", unread: false, updatedAt: 1 },
              updatedAt: 1,
              pinned: false,
              archived: false,
              parentTaskId: null,
            },
            active: false,
            now: 1000,
            depth: 0,
            last: false,
            subtasks: 0,
            collapsed: false,
            onToggle: () => {},
          }),
          createElement(Status),
        ),
      );
    });

    const readStatus = () => JSON.parse(host.querySelector("output")!.textContent!);

    // 右键弹出菜单，确认「AI 重新生成标题」紧挨在「重命名」之后
    await act(async () => {
      host
        .querySelector("[data-session-row]")!
        .dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const menuItems = Array.from(dom.document.querySelectorAll('[role="menuitem"]'));
    assert.equal(menuItems[0]?.textContent, "重命名");
    assert.equal(menuItems[1]?.textContent, "AI 重新生成标题");

    const regenBtn = dom.document.querySelector('[data-session-action="regenerate-title"]');
    assert.ok(regenBtn instanceof dom.HTMLButtonElement);
    await act(async () => {
      regenBtn.click();
    });

    // 菜单关闭，进入 busy 闪烁态，且不改变当前打开的会话
    assert.equal(dom.document.querySelector('[role="menu"]'), null);
    assert.deepEqual(calls, [{ method: "tasks.regenerateTitle", params: { taskId: "target-session" } }]);
    assert.equal(
      host.querySelector("[data-session-row]")?.getAttribute("data-regenerating-title"),
      "true",
    );
    assert.equal(readStatus().view.taskId, "active-session");

    await act(async () => {
      resolvePending?.({ title: "重构登录流程" });
    });
    assert.equal(
      host.querySelector("[data-session-row]")?.getAttribute("data-regenerating-title"),
      null,
    );
    assert.equal(readStatus().error, null);

    // 失败时通过顶部错误横幅提示
    shouldFail = true;
    const moreBtn = dom.document.querySelector('button[aria-label="对话操作"]');
    assert.ok(moreBtn instanceof dom.HTMLButtonElement);
    await act(async () => {
      moreBtn.click();
    });
    const regenBtn2 = dom.document.querySelector('[data-session-action="regenerate-title"]');
    assert.ok(regenBtn2 instanceof dom.HTMLButtonElement);
    await act(async () => {
      regenBtn2.click();
    });

    assert.equal(readStatus().error, "轻量模型生成标题失败");
    assert.equal(
      host.querySelector("[data-session-row]")?.getAttribute("data-regenerating-title"),
      null,
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
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
