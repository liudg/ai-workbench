import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

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
installGlobal("HTMLElement", dom.HTMLElement);
installGlobal("HTMLButtonElement", dom.HTMLButtonElement);
installGlobal("SVGElement", dom.SVGElement);
installGlobal("Element", dom.Element);
installGlobal("Node", dom.Node);
installGlobal("navigator", dom.navigator);
installGlobal("MutationObserver", dom.MutationObserver);
installGlobal("getComputedStyle", dom.getComputedStyle.bind(dom));
installGlobal("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
installGlobal("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));
installGlobal("fetch", () => Promise.resolve(new Response("null", { status: 200, headers: { "content-type": "application/json" } })));

let server: ViteDevServer;
let toggleMod: typeof import("../panel/core/SidebarToggle.tsx");
let chromeMod: typeof import("../panel/core/ClosedChrome.tsx");
let panelMod: typeof import("../panel/core/PanelProvider.tsx");
let panelStoreMod: typeof import("../panel/state/store.ts");
let sidebarMod: typeof import("./Sidebar.tsx");
let peekMod: typeof import("./SidebarPeek.tsx");
let visibilityMod: typeof import("../../shared/shell/sidebar-open.ts");
let daemonMod: typeof import("../../lib/daemon/index.ts");

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  toggleMod = (await server.ssrLoadModule("/src/features/panel/core/SidebarToggle.tsx")) as unknown as typeof toggleMod;
  chromeMod = (await server.ssrLoadModule("/src/features/panel/core/ClosedChrome.tsx")) as unknown as typeof chromeMod;
  panelMod = (await server.ssrLoadModule("/src/features/panel/core/PanelProvider.tsx")) as unknown as typeof panelMod;
  panelStoreMod = (await server.ssrLoadModule("/src/features/panel/state/store.ts")) as unknown as typeof panelStoreMod;
  sidebarMod = (await server.ssrLoadModule("/src/features/sidebar/Sidebar.tsx")) as unknown as typeof sidebarMod;
  peekMod = (await server.ssrLoadModule("/src/features/sidebar/SidebarPeek.tsx")) as unknown as typeof peekMod;
  visibilityMod = (await server.ssrLoadModule("/src/shared/shell/sidebar-open.ts")) as unknown as typeof visibilityMod;
  daemonMod = (await server.ssrLoadModule("/src/lib/daemon/index.ts")) as unknown as typeof daemonMod;
});

after(async () => {
  // 侧栏会连 daemon；测试里没有 daemon，停掉重试，进程才能退出。
  daemonMod?.daemon.stop();
  visibilityMod?.setSidebarOpen(true);
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

function enter(target: { dispatchEvent: (event: any) => void }) {
  target.dispatchEvent(new dom.MouseEvent("mouseover", { bubbles: true }));
}

function leave(target: { dispatchEvent: (event: any) => void }) {
  target.dispatchEvent(
    new dom.MouseEvent("mouseout", {
      bubbles: true,
      relatedTarget: dom.document.documentElement,
    }),
  );
}

async function render(node: ReturnType<typeof createElement>) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(node);
  });
  return {
    host,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("the session header toggle shares the sidebar state and stays in front of the title", async () => {
  visibilityMod.setSidebarOpen(true);
  const view = await render(
    createElement(panelMod.PanelHost, {
      state: {
        use: (select) => panelStoreMod.usePanelStore(select),
        get: () => panelStoreMod.usePanelStore.getState(),
      },
      data: {} as never,
      changes: undefined,
      status: undefined,
      subscriptionSupported: false,
      sessionId: "s",
      projectId: "p",
      projectPath: "/tmp/demo",
      sessionTitle: "示例会话",
      agent: null,
      events: [],
      usage: null,
      children: createElement(chromeMod.ClosedChrome),
    }),
  );

  const button = dom.document.querySelector("[data-sidebar-toggle]");
  const title = dom.document.querySelector("[data-session-title]");
  assert.ok(button instanceof dom.HTMLButtonElement);
  assert.ok(title);
  assert.equal(button.compareDocumentPosition(title) & dom.Node.DOCUMENT_POSITION_FOLLOWING, dom.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(button.getAttribute("data-sidebar-toggle-state"), "open");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.getAttribute("aria-label"), "隐藏侧边栏 Ctrl+B");
  assert.equal(button.className.includes("h-7"), true);
  assert.equal(button.className.includes("w-7"), true);
  assert.equal(button.className.includes("rounded-md"), true);
  assert.equal(dom.document.body.textContent?.includes("隐藏侧边栏"), true);
  assert.equal(dom.document.body.textContent?.includes("Ctrl+B"), true);
  assert.equal(title.textContent, "示例会话");

  await act(async () => {
    button.click();
  });
  assert.equal(visibilityMod.isSidebarOpen(), false);
  assert.equal(button.getAttribute("data-sidebar-toggle-state"), "closed");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.getAttribute("aria-label"), "显示侧边栏 Ctrl+B");
  assert.equal(dom.document.body.textContent?.includes("显示侧边栏"), true);
  assert.equal(dom.document.querySelector("[data-sidebar-toggle]"), button);

  await act(async () => {
    visibilityMod.toggleSidebar();
  });
  assert.equal(visibilityMod.isSidebarOpen(), true);
  assert.equal(button.getAttribute("data-sidebar-toggle-state"), "open");
  assert.equal(button.getAttribute("aria-label"), "隐藏侧边栏 Ctrl+B");

  await view.unmount();
  visibilityMod.setSidebarOpen(true);
});

test("hovering the left edge slides the sidebar over the content, and leaving retracts it", async () => {
  visibilityMod.setSidebarOpen(false);
  const pressed: string[] = [];
  const view = await render(
    createElement(
      peekMod.SidebarPeek,
      null,
      createElement(
        "button",
        {
          type: "button",
          "data-peek-session": "",
          onClick: () => pressed.push("session"),
        },
        "会话甲",
      ),
    ),
  );

  const edge = dom.document.querySelector("[data-sidebar-edge]");
  const accent = dom.document.querySelector("[data-sidebar-accent]");
  const peekRoot = dom.document.querySelector("[data-sidebar-peek-root]");
  assert.ok(edge);
  assert.ok(accent);
  assert.ok(peekRoot);
  assert.equal(accent.className.includes("bg-[#6e5bff]"), true);
  assert.equal(peekRoot.className.includes("fixed"), true);
  assert.equal(dom.document.querySelector("[data-sidebar-peek]"), null);

  await act(async () => {
    enter(edge);
  });
  assert.equal(dom.document.querySelector("[data-sidebar-peek]")?.getAttribute("data-sidebar-peek"), "open");
  const session = dom.document.querySelector("[data-peek-session]");
  assert.ok(session instanceof dom.HTMLButtonElement);
  assert.equal(peekRoot.contains(session), true);
  await act(async () => {
    session.click();
  });
  assert.deepEqual(pressed, ["session"]);
  assert.equal(dom.document.querySelector("[data-sidebar-peek]")?.getAttribute("data-sidebar-peek"), "open");

  await act(async () => {
    leave(peekRoot);
  });
  assert.equal(dom.document.querySelector("[data-sidebar-peek]")?.getAttribute("data-sidebar-peek"), "closed");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, peekMod.SIDEBAR_PEEK_MS + 40));
  });
  assert.equal(dom.document.querySelector("[data-sidebar-peek]"), null);
  assert.ok(dom.document.querySelector("[data-sidebar-edge]"));

  await view.unmount();
});

test("the header button pins the sidebar open instead of leaving it as a hover layer", async () => {
  visibilityMod.setSidebarOpen(false);
  const view = await render(
    createElement(
      "div",
      null,
      createElement(sidebarMod.Sidebar),
      createElement(toggleMod.SidebarToggle),
    ),
  );

  assert.equal(dom.document.querySelector("[data-sidebar-open]"), null);
  assert.ok(dom.document.querySelector("[data-sidebar-edge]"));
  const edge = dom.document.querySelector("[data-sidebar-edge]");
  assert.ok(edge);
  await act(async () => {
    enter(edge);
  });
  assert.equal(dom.document.querySelector("[data-sidebar-peek]")?.getAttribute("data-sidebar-peek"), "open");
  assert.ok(dom.document.querySelector("[data-sidebar-peek] [data-sidebar-open]"));

  const toggle = dom.document.querySelector("[data-sidebar-toggle]");
  assert.ok(toggle instanceof dom.HTMLButtonElement);
  assert.equal(toggle.getAttribute("data-sidebar-toggle-state"), "closed");
  await act(async () => {
    toggle.click();
  });
  assert.equal(visibilityMod.isSidebarOpen(), true);
  assert.equal(toggle.getAttribute("data-sidebar-toggle-state"), "open");
  assert.equal(dom.document.querySelector("[data-sidebar-peek-root]"), null);
  assert.ok(dom.document.querySelector("[data-sidebar-open]"));

  await view.unmount();
  visibilityMod.setSidebarOpen(true);
});
