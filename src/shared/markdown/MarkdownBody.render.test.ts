import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

function render(text: string): string {
  return renderToStaticMarkup(
    createElement(
      MarkdownHost,
      {
        api: {
          canOpen: true,
          openHref: () => undefined,
          renderImage: () => null,
          renderWebsite: () => null,
        },
      },
      createElement(MarkdownBody, { text }),
    ),
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
