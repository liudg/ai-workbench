import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

let server: ViteDevServer;

before(async () => {
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
});

after(async () => {
  await server?.close();
});

async function renderChrome(path: string) {
  const tabs = await server.ssrLoadModule("/src/features/panel/files/FileTabs.tsx");
  const column = await server.ssrLoadModule("/src/features/panel/files/FilePreview.tsx");
  return renderToStaticMarkup(
    createElement(
      "div",
      { "data-open-files": "true" },
      createElement(tabs.FileTabs, {
        tabs: [{ path, line: null }],
        activePath: path,
        onSelect: () => undefined,
        onClose: () => undefined,
        onAdd: () => undefined,
      }),
      createElement(column.FilePreviewColumn, {
        projectId: "p",
        projectPath: "C:/work/demo",
        previewPath: path,
        previewLine: null,
        treeOpen: true,
        onToggleTree: () => undefined,
        onSelectFile: () => undefined,
        onQuote: () => undefined,
      }),
    ),
  );
}

test("markdown opened in the shared shell keeps file tabs, breadcrumb, and the toolbar", async () => {
  const html = await renderChrome("docs/readme.md");
  const tabBar = html.indexOf("data-file-tabs");
  const pathLine = html.indexOf("data-preview-path-line");
  const toolbar = html.indexOf("data-preview-toolbar");
  const toggle = html.indexOf("data-markdown-mode-toggle");
  const body = html.indexOf("data-open-files-preview");
  assert.equal(tabBar >= 0 && tabBar < pathLine && pathLine < toolbar && toolbar < toggle && toggle < body, true);
  assert.equal(html.includes("readme.md"), true);
  assert.equal(html.includes("查看源代码"), true);
  assert.equal(html.includes("data-open-with"), true);
  assert.equal(html.includes(">打开<"), true);
  assert.equal(html.includes("data-copy-path"), true);
  assert.equal(html.includes("data-file-search-open"), true);
  assert.equal(html.includes("data-toggle-file-tree"), true);
  assert.equal(html.includes("data-file-tab-add"), true);
  assert.equal(html.includes("data-file-tab=\"docs/readme.md\""), true);
});

test("a source file uses the same chrome without the markdown toggle", async () => {
  const html = await renderChrome("src/app.ts");
  assert.equal(html.includes("data-file-tabs"), true);
  assert.equal(html.includes("data-preview-toolbar"), true);
  assert.equal(html.includes("data-open-with"), true);
  assert.equal(html.includes("data-markdown-mode-toggle"), false);
  assert.equal(html.includes("app.ts"), true);
});
