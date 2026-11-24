import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

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
installGlobal("HTMLButtonElement", dom.HTMLButtonElement);
installGlobal("Element", dom.Element);
installGlobal("Node", dom.Node);
installGlobal("navigator", dom.navigator);
installGlobal("MutationObserver", dom.MutationObserver);
installGlobal("ResizeObserver", dom.ResizeObserver);
installGlobal("getComputedStyle", dom.getComputedStyle.bind(dom));
installGlobal("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
installGlobal("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));

let server: ViteDevServer;
let OpenFilesViewMod: typeof import("../files/OpenFilesView.tsx");
let MarkdownViewerMod: typeof import("../viewers/markdown.tsx");
let PanelProviderMod: typeof import("../core/PanelProvider.tsx");
let StoreMod: typeof import("../state/store.ts");

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    logLevel: "error",
  });
  OpenFilesViewMod = (await server.ssrLoadModule(
    "/src/features/panel/files/OpenFilesView.tsx",
  )) as typeof import("../files/OpenFilesView.tsx");
  MarkdownViewerMod = (await server.ssrLoadModule(
    "/src/features/panel/viewers/markdown.tsx",
  )) as typeof import("../viewers/markdown.tsx");
  PanelProviderMod = (await server.ssrLoadModule(
    "/src/features/panel/core/PanelProvider.tsx",
  )) as typeof import("../core/PanelProvider.tsx");
  StoreMod = (await server.ssrLoadModule(
    "/src/features/panel/state/store.ts",
  )) as typeof import("../state/store.ts");
});

after(async () => {
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

test("OpenFilesScreen opens markdown path:line in source view and switches cleanly on first toggle click without chrome/body inversion", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);

  const emptySnippets: readonly never[] = [];
  const panelData = {
    readPreviewFile: async () => ({
      path: "G:/document/ai-workbench/README.md",
      name: "README.md",
      kind: "markdown",
      text: "# Title\nsecond line target\nthird line",
      truncated: false,
    }),
    listDir: async () => [],
    textSnippets: {
      subscribe: () => () => undefined,
      read: () => emptySnippets,
    },
  };

  function Harness({ initialLine }: { initialLine: number | null }) {
    const [payload, setPayload] = useState<Record<string, unknown>>({
      path: "README.md",
      line: initialLine,
      tabs: [{ path: "README.md", line: initialLine }],
      filter: "",
    });
    return createElement(PanelProviderMod.PanelHost, {
      state: {
        use: (select) => StoreMod.usePanelStore(select),
        get: () => StoreMod.usePanelStore.getState(),
      },
      data: panelData as never,
      changes: undefined,
      status: undefined,
      subscriptionSupported: false,
      sessionId: "s",
      projectId: "p",
      projectPath: "G:/document/ai-workbench",
      sessionTitle: "",
      agent: null,
      events: [],
      usage: null,
      children: createElement(OpenFilesViewMod.OpenFilesScreen, {
        tabs: [{ id: "files", viewerId: "files", payload }],
        projectId: "p",
        projectPath: "G:/document/ai-workbench",
        sessionId: "s",
        filesTreeWidth: null,
        setFilesTreeWidth: () => undefined,
        filesTreeOpen: false,
        toggleFilesTree: () => undefined,
        patchTabPayload: (_id, patch) => setPayload((prev) => ({ ...prev, ...patch })),
      }),
    });
  }

  try {
    dom.window.localStorage.clear();
    await act(async () => {
      root.render(createElement(Harness, { key: "with-line", initialLine: 2 }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });

    // 1. Opens in source mode at line 2, and PreviewChrome button matches ("查看预览") without overwriting storage
    assert.equal(host.querySelector("[data-markdown-view]")?.getAttribute("data-markdown-view"), "source");
    const lineRow = host.querySelector('[data-source-line="2"]');
    assert.ok(lineRow);
    assert.equal(lineRow.textContent?.includes("second line target"), true);
    assert.equal(lineRow.className.includes("wb-line-focus-bg"), true);

    const toggleBtn = host.querySelector("[data-markdown-mode-toggle]") as unknown as HTMLButtonElement;
    assert.ok(toggleBtn);
    assert.equal(toggleBtn.textContent, "查看预览");
    assert.equal(dom.window.localStorage.length, 0, "auto source mode must not overwrite stored preference");

    // 2. First click on "查看预览" immediately switches BOTH body and chrome label to preview!
    await act(async () => {
      toggleBtn.click();
    });
    assert.equal(host.querySelector("[data-markdown-view]")?.getAttribute("data-markdown-view"), "preview");
    assert.equal(toggleBtn.textContent, "查看源代码");
    assert.equal(host.querySelector('[data-source-line="2"]'), null);

    // 3. Second click switches back to source cleanly
    await act(async () => {
      toggleBtn.click();
    });
    assert.equal(host.querySelector("[data-markdown-view]")?.getAttribute("data-markdown-view"), "source");
    assert.equal(toggleBtn.textContent, "查看预览");

    // 4. Standalone markdownViewer also honors target.line -> initial source mode + highlighted line
    dom.window.localStorage.clear();
    const loaded = await MarkdownViewerMod.markdownViewer.load!(
      { kind: "file", path: "G:/document/ai-workbench/README.md", line: 2 },
      {
        projectId: "p",
        projectPath: "G:/document/ai-workbench",
        sessionId: "s",
        sessionFiles: [],
        data: panelData as never,
      },
    );
    assert.equal(loaded.line, 2);

    await act(async () => {
      root.render(
        createElement(PanelProviderMod.PanelHost, {
          state: {
            use: (select) => StoreMod.usePanelStore(select),
            get: () => StoreMod.usePanelStore.getState(),
          },
          data: panelData as never,
          changes: undefined,
          status: undefined,
          subscriptionSupported: false,
          sessionId: "s",
          projectId: "p",
          projectPath: "G:/document/ai-workbench",
          sessionTitle: "",
          agent: null,
          events: [],
          usage: null,
          children: createElement(MarkdownViewerMod.markdownViewer.View, {
            tabId: "md-1",
            payload: loaded,
            status: "ready",
            sessionId: "s",
            projectId: "p",
            setTitle: () => {},
          }),
        }),
      );
    });
    assert.equal(host.querySelector("[data-markdown-view]")?.getAttribute("data-markdown-view"), "source");
    assert.ok(host.querySelector('[data-source-line="2"]')?.className.includes("wb-line-focus-bg"));
  } finally {
    dom.window.localStorage.clear();
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
});
