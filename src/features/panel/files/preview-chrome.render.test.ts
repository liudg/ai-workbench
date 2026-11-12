import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

let server: ViteDevServer;
let view: typeof import("./OpenFilesView.tsx");
let chromeModule: typeof import("./PreviewChrome.tsx");
let panelModule: typeof import("../core/PanelProvider.tsx");
let storeModule: typeof import("../state/store.ts");

before(async () => {
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  view = (await server.ssrLoadModule("/src/features/panel/files/OpenFilesView.tsx")) as typeof import("./OpenFilesView.tsx");
  chromeModule = (await server.ssrLoadModule(
    "/src/features/panel/files/PreviewChrome.tsx",
  )) as typeof import("./PreviewChrome.tsx");
  panelModule = (await server.ssrLoadModule("/src/features/panel/core/PanelProvider.tsx")) as typeof import("../core/PanelProvider.tsx");
  storeModule = (await server.ssrLoadModule("/src/features/panel/state/store.ts")) as typeof import("../state/store.ts");
});

after(async () => {
  await server?.close();
});

/** 打开的文件读面板的数据来源，外面套一层面板。这里只看排版，数据不会被调用。 */
function inPanel(child: ReturnType<typeof createElement>) {
  return createElement(panelModule.PanelHost, {
    state: {
      use: (select) => storeModule.usePanelStore(select),
      get: () => storeModule.usePanelStore.getState(),
    },
    data: {} as never,
    changes: undefined,
    status: undefined,
    subscriptionSupported: false,
    sessionId: "s",
    projectId: "p",
    projectPath: "C:/work/demo",
    sessionTitle: "",
    agent: null,
    events: [],
    usage: null,
    children: child,
  });
}

function screen(path: string, treeOpen = true) {
  return renderToStaticMarkup(
    inPanel(createElement(view.OpenFilesScreen, {
      tabs: [
        {
          id: "files",
          viewerId: "files",
          payload: { path, line: null, tabs: path ? [{ path, line: null }] : [], filter: "" },
        },
      ],
      projectId: "p",
      projectPath: "C:/work/demo",
      sessionId: "s",
      filesTreeWidth: null,
      setFilesTreeWidth: () => undefined,
      filesTreeOpen: treeOpen,
      toggleFilesTree: () => undefined,
      patchTabPayload: () => undefined,
    })),
  );
}

function openingTag(html: string, marker: string): string {
  const at = html.indexOf(marker);
  assert.ok(at >= 0, marker);
  const start = html.lastIndexOf("<", at);
  const end = html.indexOf(">", at);
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end + 1);
}

test("the preview toolbar is one row spanning the file tree", async () => {
  const html = screen("docs/readme.md");
  const tabs = html.indexOf("data-file-tabs");
  const chrome = html.indexOf('data-preview-chrome="true"');
  const toolbar = html.indexOf('data-preview-toolbar="true"');
  const path = html.indexOf('data-preview-path-line="true"');
  const actions = html.indexOf('data-preview-actions="true"');
  const split = html.indexOf('data-open-files-split="true"');
  const column = html.indexOf('data-file-preview-column="true"');
  const tree = html.indexOf('data-workspace-tree="true"');
  const filter = html.indexOf("data-files-filter");
  const body = html.indexOf("data-open-files-preview");
  assert.equal(html.split('data-preview-chrome="true"').length - 1, 1);
  assert.ok(tabs >= 0 && tabs < chrome && chrome < split && split < column && column < tree);
  assert.ok(Math.abs(chrome - toolbar) < 40);
  assert.ok(path > chrome && path < actions && actions < split);
  assert.ok(filter > tree);
  assert.ok(body > split && body < tree);
  assert.equal(html.slice(column, tree).includes("data-preview-chrome"), false);
  assert.equal(html.slice(tree).includes("data-preview-toolbar"), false);

  const bar = openingTag(html, 'data-preview-chrome="true"');
  assert.match(bar, /\bh-10\b/);
  assert.match(bar, /\bpx-2\b/);
  assert.match(bar, /\bborder-b\b/);
  const pathTag = openingTag(html, 'data-preview-path-line="true"');
  assert.match(pathTag, /\bmin-w-0\b/);
  assert.match(pathTag, /\boverflow-hidden\b/);
  assert.match(pathTag, /\btext-ellipsis\b/);
  assert.match(pathTag, /\bwhitespace-nowrap\b/);
  const actionTag = openingTag(html, 'data-preview-actions="true"');
  assert.match(actionTag, /\bml-auto\b/);
  assert.match(actionTag, /\bshrink-0\b/);

  const search = html.indexOf("data-file-search-open");
  const toggle = html.indexOf("data-markdown-mode-toggle");
  const copy = html.indexOf("data-copy-path");
  const openWith = html.indexOf('data-open-with="true"');
  const menu = html.indexOf('data-open-with-menu-button="true"');
  const treeButton = html.indexOf('data-toggle-file-tree="true"');
  assert.ok(actions < search && search < toggle && toggle < copy && copy < openWith && openWith < menu && menu < treeButton && treeButton < split);
  assert.equal(html.includes("readme.md"), true);
  assert.equal(html.includes("查看源代码"), true);
  assert.equal(html.includes(">打开<"), true);
  assert.equal(html.includes("data-file-tab-add"), true);
  assert.equal(html.includes('data-file-tab="docs/readme.md"'), true);
});

test("a source file uses the same full-width row without the markdown toggle", async () => {
  const html = screen("src/app.ts");
  const actions = html.indexOf('data-preview-actions="true"');
  const search = html.indexOf("data-file-search-open");
  const copy = html.indexOf("data-copy-path");
  const openWith = html.indexOf('data-open-with="true"');
  const split = html.indexOf('data-open-files-split="true"');
  assert.equal(html.includes("data-file-tabs"), true);
  assert.equal(html.includes('data-preview-toolbar="true"'), true);
  assert.equal(html.includes("data-markdown-mode-toggle"), false);
  assert.equal(html.includes("app.ts"), true);
  assert.ok(actions < search && search < copy && copy < openWith && openWith < split);
  assert.ok(html.indexOf('data-file-preview-column="true"') > split);
});

test("the file tree toggle uses the folder icon, pressed fill, and a right-aligned hint", async () => {
  const open = screen("src/app.ts", true);
  const button = openingTag(open, 'data-toggle-file-tree="true"');
  assert.match(button, /\bh-7\b/);
  assert.match(button, /\bw-7\b/);
  assert.match(button, /rounded-md/);
  assert.match(button, /bg-wb-active/);
  assert.match(button, /aria-pressed="true"/);
  assert.equal(button.includes("title="), false);
  assert.match(open, /data-file-tree-icon="folder"/);
  const hint = open.slice(open.indexOf('data-toggle-file-tree="true"'));
  assert.match(hint, /role="tooltip"/);
  assert.match(hint, /\bright-0\b/);
  assert.match(hint, /切换文件树/);
  assert.equal(open.includes("data-workspace-tree"), true);

  const closed = screen("docs/note.md", false);
  const closedButton = openingTag(closed, 'data-toggle-file-tree="true"');
  assert.match(closedButton, /aria-pressed="false"/);
  assert.equal(closedButton.includes("bg-wb-active"), false);
  assert.equal(closed.includes("data-workspace-tree"), false);
  assert.ok(closed.indexOf('data-preview-chrome="true"') < closed.indexOf('data-open-files-split="true"'));
  assert.match(closed, /切换文件树/);
  assert.match(closed, /data-file-tree-icon="folder"/);
});

test("the open control is one capsule with a divider between the two halves", async () => {
  const html = screen("src/app.ts");
  const capsule = openingTag(html, 'data-open-with="true"');
  const left = openingTag(html, 'data-open-with-default="true"');
  const right = openingTag(html, 'data-open-with-menu-button="true"');
  const dividerAt = html.indexOf('data-open-with-divider="true"');
  const leftAt = html.indexOf('data-open-with-default="true"');
  const rightAt = html.indexOf('data-open-with-menu-button="true"');
  assert.match(capsule, /rounded-lg/);
  assert.match(capsule, /border/);
  assert.equal(capsule.includes("hover:"), false);
  assert.match(left, /hover:bg-wb-hover/);
  assert.match(right, /hover:bg-wb-hover/);
  assert.ok(leftAt < dividerAt && dividerAt < rightAt);
  assert.equal(html.slice(leftAt, dividerAt).includes(">打开<"), true);

  const bare = renderToStaticMarkup(
    createElement(chromeModule.PreviewChrome, {
      path: "src/app.ts",
      projectId: "",
      treeOpen: true,
      onToggleTree: () => undefined,
      onSelectFile: () => undefined,
      onSearch: () => undefined,
      searchEnabled: false,
    }),
  );
  assert.equal(bare.includes('data-open-with="true"'), false);
  assert.equal(bare.includes('data-toggle-file-tree="true"'), true);
  assert.match(bare, /切换文件树/);
  assert.ok(bare.indexOf('data-preview-actions="true"') < bare.indexOf('data-toggle-file-tree="true"'));
});
