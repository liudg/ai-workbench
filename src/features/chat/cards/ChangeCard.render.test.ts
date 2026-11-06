import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";

import type { TurnChanges } from "../../changes-model/diff-parse.ts";
import type { PanelData } from "../../panel/core/PanelProvider.tsx";

const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
const dom = new Window({ url: "http://localhost/" });
const globals = {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  ResizeObserver: dom.ResizeObserver,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

let server: ViteDevServer;
let card: typeof import("./ChangeCard.tsx");
let chat: typeof import("../host.tsx");
let panel: typeof import("../../panel/core/PanelProvider.tsx");
let store: typeof import("../../panel/state/store.ts");
let viewer: typeof import("../../panel/viewers/diff.tsx");
let filter: typeof import("../../panel/core/file-filter.ts");
let unregister: () => void;

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    logLevel: "error",
  });
  card = await server.ssrLoadModule("/src/features/chat/cards/ChangeCard.tsx") as typeof card;
  chat = await server.ssrLoadModule("/src/features/chat/host.tsx") as typeof chat;
  panel = await server.ssrLoadModule("/src/features/panel/core/PanelProvider.tsx") as typeof panel;
  store = await server.ssrLoadModule("/src/features/panel/state/store.ts") as typeof store;
  viewer = await server.ssrLoadModule("/src/features/panel/viewers/diff.tsx") as typeof viewer;
  filter = await server.ssrLoadModule("/src/features/panel/core/file-filter.ts") as typeof filter;
  const registry = await server.ssrLoadModule("/src/features/panel/core/registry.ts");
  unregister = registry.registerViewer(viewer.diffViewer);
});

after(async () => {
  unregister?.();
  await server?.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.close();
});

test("change-card files reuse the turn diff and exclusively reveal the clicked file", async () => {
  const changes: TurnChanges = {
    id: "turn-1",
    files: ["C:/work/demo/src/a.ts", "src/b.ts"].map((path) => ({
      path, status: "M", added: 1, removed: 1,
      diff: "@@ -1 +1 @@\n-before\n+after",
    })),
    added: 2,
    removed: 2,
  };
  const scopes = [
    { id: "turn", label: "上一轮", source: "turn" },
    { id: "working", label: "工作区", source: "git" },
  ];
  const data = {
    diffScopes: async () => scopes,
    diffForScope: async () => "",
    isGit: async () => false,
    textSnippets: { subscribe: () => () => {}, read: () => [] },
  } as unknown as PanelData;
  const state = { use: store.usePanelStore, get: store.usePanelStore.getState };
  function ActiveDiff() {
    const api = panel.usePanel();
    const tab = api.tabs.find((item) => item.id === api.activeId);
    return tab ? createElement(viewer.diffViewer.View, {
      key: tab.id,
      tabId: tab.id, payload: tab.payload as never, status: tab.status,
      sessionId: "s", projectId: "p", setTitle: () => {},
    }) : null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const click = async (selector: string) => {
    const button = container.querySelector<HTMLButtonElement>(selector);
    assert.ok(button, selector);
    await act(async () => button.click());
  };
  const switchAwayAndBack = async () => {
    await act(async () => state.get().panelOpenDiff("s", "diff:other", "Other", []));
    await act(async () => state.get().panelCloseTab("s", "diff:other"));
  };
  const expectOpen = (path: string) => {
    const sections = [...container.querySelectorAll("[data-diff-file-body]")];
    assert.equal(sections.length, 2);
    for (const section of sections) {
      const open = section.getAttribute("data-diff-file-body") === path;
      assert.equal(section.getAttribute("data-diff-open"), String(open));
      assert.equal(section.getAttribute("data-diff-active"), String(open));
    }
    assert.equal(state.get().panelBySession.s?.tabs.length, 1);
    assert.equal(state.get().panelBySession.s?.activeId, "diff:turn-1");
  };
  try {
    await act(async () => root.render(createElement(panel.PanelHost, {
      state, data, changes: undefined, status: undefined, subscriptionSupported: false,
      sessionId: "s", projectId: "p", projectPath: "C:/work/demo", sessionTitle: "",
      agent: null, events: [], usage: null,
      children: createElement(chat.ChatHostProvider, {
        host: { projectPath: "C:/work/demo", profiles: {}, answerPrompt: async () => false },
        children: createElement(Fragment, null,
          createElement(card.ChangeCard, { changes, defaultExpanded: true }),
          createElement(ActiveDiff),
        ),
      }),
    })));
    await click('[data-change-file="src/b.ts"]');
    expectOpen("src/b.ts");
    await click('[data-diff-scope]');
    await click('[data-diff-scope-item="working"]');
    assert.equal(container.querySelectorAll("[data-diff-file-body]").length, 0);
    await switchAwayAndBack();
    assert.ok(container.querySelector("[data-diff-scope]")?.textContent?.includes("工作区"));
    assert.equal(container.querySelectorAll("[data-diff-file-body]").length, 0);
    await click('[data-change-file="C:/work/demo/src/a.ts"]');
    expectOpen("src/a.ts");
    await click('[data-change-file="C:/work/demo/src/a.ts"]');
    expectOpen("src/a.ts");
    await click('[data-view-changes]');
    expectOpen("src/a.ts");
    await click('[data-diff-file-body="src/a.ts"] button[aria-expanded]');
    await switchAwayAndBack();
    assert.equal(container.querySelector('[data-diff-file-body="src/a.ts"]')?.getAttribute("data-diff-open"), "false");
    await click('[data-change-file="C:/work/demo/src/a.ts"]');
    expectOpen("src/a.ts");
    await act(async () => filter.setFileFilter("s", "a.ts"));
    await switchAwayAndBack();
    assert.deepEqual(
      [...container.querySelectorAll("[data-diff-file-body]")].map((node) => node.getAttribute("data-diff-file-body")),
      ["src/a.ts"],
    );
    await click('[data-change-file="src/b.ts"]');
    expectOpen("src/b.ts");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
