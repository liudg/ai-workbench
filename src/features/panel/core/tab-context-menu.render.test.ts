import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";

import type { PanelData } from "./PanelProvider.tsx";
import type { OpenFilesPlace } from "../files/open-files-place.ts";

const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
const dom = new Window({ url: "http://localhost/" });
const globals = {
  IS_REACT_ACT_ENVIRONMENT: true, window: dom, document: dom.document,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  ResizeObserver: dom.ResizeObserver,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
let server: ViteDevServer;
let panel: typeof import("./PanelProvider.tsx");
let tabs: typeof import("./PanelTabs.tsx");
let store: typeof import("../state/store.ts");
let registry: typeof import("./registry.ts");

before(async () => {
  server = await createServer({
    root: rootDir, configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error",
  });
  panel = await server.ssrLoadModule("/src/features/panel/core/PanelProvider.tsx") as typeof panel;
  tabs = await server.ssrLoadModule("/src/features/panel/core/PanelTabs.tsx") as typeof tabs;
  store = await server.ssrLoadModule("/src/features/panel/state/store.ts") as typeof store;
  registry = await server.ssrLoadModule("/src/features/panel/core/registry.ts") as typeof registry;
});
after(async () => {
  await server?.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.close();
});

async function mount(sessionId: string, overrides: Partial<PanelData> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const snippets: never[] = [];
  const data = {
    listDir: async () => [],
    readPreviewFile: async () => ({ kind: "text", text: "sample", truncated: false }),
    textSnippets: { subscribe: () => () => {}, read: () => snippets },
    ...overrides,
  } as unknown as PanelData;
  await act(async () => root.render(createElement(panel.PanelHost, {
    state: { use: store.usePanelStore, get: store.usePanelStore.getState }, data,
    changes: undefined, status: undefined, subscriptionSupported: false,
    sessionId, projectId: "p", projectPath: "C:/work/demo", sessionTitle: "",
    agent: null, events: [], usage: null, children: createElement(tabs.PanelTabs),
  })));
  return {
    container,
    async click(selector: string, double = false) {
      for (const type of double ? ["click", "click", "dblclick"] : ["click"]) {
        const target = container.querySelector(selector);
        assert.ok(target, selector);
        await act(async () => {
          target.dispatchEvent(new dom.MouseEvent(type, { bubbles: true, cancelable: true }) as unknown as Event);
        });
      }
    },
    async menu(selector: string) {
      const target = container.querySelector(selector);
      assert.ok(target, selector);
      await act(async () => {
        target.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 60 }) as unknown as Event);
      });
      assert.deepEqual(
        [...document.querySelectorAll("[data-context-menu] [data-menu-item]")].map((item) => item.getAttribute("data-menu-item")),
        ["close-tab", "close-other-tabs", "close-all-tabs"],
      );
    },
    async choose(id: string) {
      const item = document.querySelector<HTMLButtonElement>(`[data-menu-item="${id}"]`);
      assert.ok(item);
      await act(async () => item.click());
      assert.equal(document.querySelector("[data-context-menu]"), null);
    },
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("main tabs close the right-clicked tab, retain it when closing others, and dispose all closed tabs", async () => {
  const disposed: string[] = [];
  const undo = registry.registerViewer({
    id: "menu-test", match: (target) => target.kind === "custom" && target.type === "menu-test" ? 100 : 0,
    icon: () => null, title: (payload: { title: string }) => payload.title, View: () => null,
    dispose: (payload: { title: string }) => { disposed.push(payload.title); },
  });
  const api = store.usePanelStore.getState();
  const sessionId = "main-menu";
  for (const key of ["a", "b", "c"]) {
    await api.panelOpenTarget(sessionId, { kind: "custom", type: "menu-test", key, data: { title: key } }, {
      projectId: "p", projectPath: "C:/work/demo", sessionFiles: [],
    });
  }
  const read = () => store.usePanelStore.getState().panelBySession[sessionId]!;
  const screen = await mount(sessionId);
  try {
    await screen.menu('[data-preview-tab="menu-test"]');
    assert.equal(read().activeId, "custom:menu-test:c");
    await screen.choose("close-tab");
    assert.deepEqual(read().tabs.map((tab) => tab.id), ["custom:menu-test:b", "custom:menu-test:c"]);
    assert.equal(read().activeId, "custom:menu-test:c");
    await screen.menu('[data-preview-tab="menu-test"]');
    await screen.choose("close-other-tabs");
    assert.equal(read().activeId, "custom:menu-test:b");
    assert.equal(read().tabs.length, 1);
    await screen.menu('[data-preview-tab="menu-test"]');
    assert.equal(document.querySelector<HTMLButtonElement>('[data-menu-item="close-other-tabs"]')?.disabled, true);
    await screen.choose("close-all-tabs");
    assert.deepEqual(read().tabs, []);
    assert.equal(read().activeId, "");
    assert.equal(read().layout, "chat");
    assert.deepEqual(disposed, ["a", "c", "b"]);
  } finally {
    await screen.cleanup();
    undo();
  }
});

test("file tabs batch-close within the file viewer and keep the main tab open", async () => {
  const api = store.usePanelStore.getState();
  const sessionId = "file-menu";
  api.panelOpenFiles(sessionId);
  api.panelToggleFilesSidebar(sessionId);
  const initial: OpenFilesPlace = {
    path: "c.ts", line: null, filter: "saved filter",
    tabs: ["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => ({ path, line: null })),
  };
  api.panelPatchTabPayload(sessionId, "custom:open-files", { ...initial });
  const read = () => store.usePanelStore.getState().panelBySession[sessionId]!;
  const place = () => read().tabs[0].payload as OpenFilesPlace;
  const screen = await mount(sessionId);
  try {
    await screen.menu('[data-file-tab="a.ts"]');
    assert.equal(place().path, "c.ts");
    await screen.choose("close-tab");
    assert.deepEqual(place().tabs.map((tab) => tab.path), ["b.ts", "c.ts", "d.ts"]);
    assert.equal(place().path, "c.ts");
    await screen.menu('[data-file-tab="b.ts"]');
    await screen.choose("close-other-tabs");
    assert.deepEqual(place().tabs.map((tab) => tab.path), ["b.ts"]);
    assert.equal(place().path, "b.ts");
    await screen.menu('[data-file-tab="b.ts"]');
    assert.equal(document.querySelector<HTMLButtonElement>('[data-menu-item="close-other-tabs"]')?.disabled, true);
    await screen.choose("close-all-tabs");
    assert.equal(read().tabs.length, 1);
    assert.equal(read().activeId, "custom:open-files");
    assert.deepEqual(place().tabs, []);
    assert.equal(place().path, "");
    assert.equal(place().line, null);
    assert.equal(place().filter, "saved filter");
    assert.ok(screen.container.querySelector("[data-open-files-empty]"));
  } finally {
    await screen.cleanup();
  }
});

test("tree clicks reuse an italic preview and double-clicking files or tabs keeps them open", async () => {
  const api = store.usePanelStore.getState();
  const sessionId = "file-preview-tabs";
  api.panelOpenFiles(sessionId);
  const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
  const screen = await mount(sessionId, {
    listDir: async () => paths.map((path) => ({ path, name: path, kind: "file" })),
    filterPaths: async () => ({ paths: ["filtered.ts"], truncated: false, cancelled: false, ready: true }),
  });
  const place = () => store.usePanelStore.getState().panelBySession[sessionId]!.tabs[0].payload as OpenFilesPlace;
  const expectTabs = (kept: string[], preview?: string) => {
    assert.deepEqual(place().tabs.map((tab) => tab.path), [...kept, ...(preview ? [preview] : [])]);
    for (const tab of place().tabs) {
      const node = screen.container.querySelector(`[data-file-tab="${tab.path}"]`);
      assert.ok(node);
      assert.equal(node.classList.contains("italic"), tab.path === preview);
      assert.equal(node.getAttribute("data-preview"), String(tab.path === preview));
    }
  };
  try {
    await screen.click('[data-workspace-file="a.ts"]');
    expectTabs(["a.ts"]);
    await screen.click('[data-workspace-file="b.ts"]');
    expectTabs(["a.ts"], "b.ts");
    await screen.click('[data-workspace-file="c.ts"]');
    expectTabs(["a.ts"], "c.ts");
    await screen.click('[data-file-tab="c.ts"]', true);
    expectTabs(["a.ts", "c.ts"]);
    await screen.click('[data-workspace-file="d.ts"]');
    expectTabs(["a.ts", "c.ts"], "d.ts");
    await screen.click('[data-workspace-file="e.ts"]', true);
    expectTabs(["a.ts", "c.ts", "e.ts"]);
    await screen.click('[data-workspace-file="d.ts"]');
    await screen.click('[data-file-tab="a.ts"]');
    expectTabs(["a.ts", "c.ts", "e.ts"], "d.ts");
    await screen.click('[data-workspace-file="f.ts"]');
    expectTabs(["a.ts", "c.ts", "e.ts"], "f.ts");
    await act(async () => api.panelPatchTabPayload(sessionId, "custom:open-files", { filter: "filtered" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    await screen.click('[data-workspace-file="filtered.ts"]', true);
    expectTabs(["a.ts", "c.ts", "e.ts", "filtered.ts"]);
    await screen.menu('[data-file-tab="filtered.ts"]');
    await screen.choose("close-all-tabs");
    await screen.click('[data-workspace-file="filtered.ts"]');
    expectTabs(["filtered.ts"]);
  } finally {
    await screen.cleanup();
  }
});
