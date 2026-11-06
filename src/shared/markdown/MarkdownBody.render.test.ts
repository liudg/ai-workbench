import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

let server: ViteDevServer;
let MarkdownBody: typeof import("./MarkdownBody.tsx").MarkdownBody;
let MarkdownHost: typeof import("./host.tsx").MarkdownHost;

before(async () => {
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  MarkdownBody = (await server.ssrLoadModule("/src/shared/markdown/MarkdownBody.tsx")).MarkdownBody;
  MarkdownHost = (await server.ssrLoadModule("/src/shared/markdown/host.tsx")).MarkdownHost;
});

after(async () => {
  await server?.close();
});

function render(text: string, runCommand?: (command: string) => void): string {
  return renderToStaticMarkup(
    createElement(MarkdownHost, {
      api: {
        canOpen: true,
        openHref: () => undefined,
        renderImage: () => null,
        renderWebsite: () => null,
        runCommand,
      },
      children: createElement(MarkdownBody, { text }),
    }),
  );
}

test("an inline file location is a citation pill and the line is not part of the path", () => {
  const html = render("先看 [LoginService.cs:648](F:/work/src/Auth/LoginService.cs:648) 这里。");
  assert.match(html, /data-answer-cite/);
  assert.match(html, /data-cite-path="F:\/work\/src\/Auth\/LoginService.cs"/);
  assert.match(html, /data-cite-line="648"/);
  assert.match(html, /answer-cite-name">LoginService\.cs</);
  assert.match(html, /answer-cite-line">648</);
  assert.equal(html.includes("answer-file\""), false);
  assert.equal(html.includes(":648"), false);
  assert.equal(html.includes("data-answer-disclosure"), false);
});

test("inline HTML filenames and paths can open a preview without a line number", () => {
  for (const path of [
    "index.html",
    "page.HTM",
    "./output/index.html",
    "C:\\Users\\admin\\Documents\\AI Workbench\\index.html",
    "file:///C:/work/demo/index.html",
  ]) {
    const html = render(`已生成 \`${path}\`，可以预览。`);
    assert.match(html, /<button[^>]*data-answer-cite/, path);
    assert.ok(html.includes(`data-cite-path="${path}"`), path);
    assert.equal(html.includes("data-cite-line="), false, path);
  }
});

test("HTML line references still navigate to source and commands remain code", () => {
  const html = render("查看 `index.html:12`。");
  assert.match(html, /data-cite-path="index.html"/);
  assert.match(html, /data-cite-line="12"/);
  for (const code of ["start index.html", "python build.py > index.html", "*.html", "https://example.com/index.html"]) {
    const rendered = render(`运行 \`${code}\`。`);
    assert.equal(rendered.includes("data-answer-cite"), false, code);
    assert.match(rendered, /answer-inline-code/);
  }
  assert.equal(render("```html\nindex.html\n```").includes("data-answer-cite"), false);
});

test("HTML code labels inside web links do not become nested file buttons", () => {
  const html = render("查看 [`index.html`](https://example.com/docs)，或 [**`index.html`**](https://example.com/docs)。");
  assert.equal(html.match(/<a href="https:\/\/example.com\/docs"/g)?.length, 2);
  assert.equal(html.includes("data-answer-cite"), false);
  assert.equal(html.match(/answer-inline-code/g)?.length, 2);
});

test("standalone HTML Markdown links still use website cards", () => {
  for (const href of ["index.html", "C:/work/demo/index.html", "https://example.com/index.html"]) {
    const sites: [string, string][] = [];
    renderToStaticMarkup(createElement(MarkdownHost, {
      api: {
        canOpen: true,
        openHref: () => assert.fail("rendering must not open a file"),
        renderImage: () => null,
        renderWebsite: (path, label) => { sites.push([path, label]); return null; },
      },
      children: createElement(MarkdownBody, { text: `[预览页面](${href})` }),
    }));
    assert.deepEqual(sites, [[href, "预览页面"]]);
  }
});

test("code stays readable without a preview host", () => {
  const html = renderToStaticMarkup(createElement(MarkdownBody, { text: "`index.html` 已生成。" }));
  assert.match(html, /answer-inline-code/);
  assert.equal(html.includes("<button"), false);
});

test("clicking an inline HTML file sends the original path to the preview host", async () => {
  const dom = new Window({ url: "http://localhost/" });
  const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = dom.document.createElement("div");
  const view = createRoot(container as unknown as HTMLElement);
  const opened: [string, number | undefined][] = [];
  const path = "C:\\Users\\admin\\Documents\\AI Workbench\\index.html";
  const cases: [string, string, number | undefined][] = [
    ["`index.html` 已放在工作区根目录。", "index.html", undefined],
    [`\`${path}\``, path, undefined],
    ["源码见 `index.html:12`。", "index.html", 12],
    ["Cursor 根据 [tiger-leopard-cycling.html](tiger-leopard-cycling.html) 的代码给出评价。", "tiger-leopard-cycling.html", undefined],
    ["查看 [`index.html`](<C:/work/my project/index.html>)。", "C:/work/my project/index.html", undefined],
    ["查看 [index.html](file:///C:/work/demo/index.html)。", "file:///C:/work/demo/index.html", undefined],
    ["查看 [index.html](index.html#L12)。", "index.html", 12],
    ["查看 `index.html (line 12)`。", "index.html", 12],
    ["查看 `src/app.ts:12`。", "src/app.ts", 12],
  ];
  try {
    await act(async () => view.render(createElement(MarkdownHost, {
      api: {
        canOpen: true,
        openHref: (href, line) => { opened.push([href, line]); },
        renderImage: () => null,
        renderWebsite: () => null,
      },
      children: createElement(MarkdownBody, {
        text: cases.map(([text]) => text).join("\n\n"),
      }),
    })));
    const buttons = container.querySelectorAll("button[data-answer-cite]");
    assert.equal(buttons.length, cases.length);
    await act(async () => {
      for (const button of buttons) {
        assert.ok(button instanceof dom.HTMLButtonElement);
        button.click();
      }
    });
    assert.deepEqual(opened, cases.map(([, href, line]) => [href, line]));
  } finally {
    await act(async () => view.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await dom.close();
  }
});

test("five file refs stack and keep two behind 显示另外", () => {
  const lines = [1, 2, 3, 4, 5].map(
    (line) => `- [File${line}.cs](F:/work/src/Auth/File${line}.cs:${line * 10})：说明${line}`,
  );
  const html = render(lines.join("\n"));
  assert.match(html, /data-answer-file-list/);
  assert.match(html, /answer-file-list-label">代码入口</);
  assert.equal(html.match(/data-answer-cite/g)?.length, 3);
  assert.match(html, /data-cite-path="F:\/work\/src\/Auth\/File1.cs"/);
  assert.match(html, /data-cite-line="10"/);
  assert.match(html, /说明1/);
  assert.equal(html.includes("File4.cs"), false);
  assert.match(html, /data-show-more/);
  assert.match(html, /显示另外 2 个/);
  assert.equal(html.includes("data-answer-disclosure"), false);
  assert.equal(html.includes("<ol"), false);
  assert.equal(html.includes("<ul"), false);
  assert.equal(html.includes("answer-file\""), false);
});

test("four file refs stay visible without a show-more control", () => {
  const lines = [1, 2, 3, 4].map((line) => `- [File${line}.cs](F:/work/src/Auth/File${line}.cs:${line})`);
  const html = render(lines.join("\n"));
  assert.equal(html.match(/data-answer-cite/g)?.length, 4);
  assert.equal(html.includes("data-show-more"), false);
  assert.equal(html.includes("data-answer-disclosure"), false);
});

test("a shell block gets run and copy when a terminal is available", () => {
  const html = render("```bash\npnpm tauri:dev\n```", () => undefined);
  assert.match(html, /data-answer-block="command"/);
  assert.match(html, /aria-label="在终端中运行"/);
  assert.match(html, /aria-label="复制"/);
  assert.match(html, /pnpm tauri:dev/);
});

test("a shell block without a terminal only copies, other code stays plain", () => {
  const shell = render("```sh\nls\n```");
  assert.match(shell, /aria-label="复制"/);
  assert.equal(shell.includes("在终端中运行"), false);
  const code = render("```ts\nconst a = 1;\n```", () => undefined);
  assert.equal(code.includes('data-answer-block="command"'), false);
});
