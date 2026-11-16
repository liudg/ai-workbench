import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

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

test("含有段落和代码块的四项列表保持连续编号和所属层级", async () => {
  const text = readFileSync(new URL("./fixtures/ordered-list.md", import.meta.url), "utf8");
  const dom = new Window();
  try {
    dom.document.body.innerHTML = render(text);
    const lists = dom.document.querySelectorAll("ol");
    assert.equal(lists.length, 1);
    assert.equal(lists[0].start, 1);
    const items = lists[0].querySelectorAll(":scope > li");
    assert.equal(items.length, 4);
    assert.deepEqual(
      [...items].map((item) => item.querySelector("strong")?.textContent),
      ["私有内核连接节点服务器时，被 TUN 接管。", "DNS 解析受到影响。", "部分应用子进程可能直接使用 Clash Verge。", "最终出口 IP 不一定改变。"],
    );
    assert.equal(items[0].querySelectorAll(":scope > .answer-p").length, 3);
    assert.equal(items[0].querySelector("pre")?.textContent, "Claude → 私有 Mihomo → Clash Verge TUN → 节点服务器 → 目标网站");
    for (const item of [...items].slice(1)) {
      assert.equal(item.querySelectorAll(":scope > .answer-p").length, 2);
    }
    assert.equal(items[1].querySelector("a")?.href, "https://wiki.metacubex.one/config/dns/");
    assert.match(lists[0].nextElementSibling?.textContent ?? "", /^此前方案/);
  } finally {
    await dom.close();
  }
});

test("保留列表起始编号并支持重复使用 1 的 Markdown 写法", async () => {
  const dom = new Window();
  try {
    for (const start of [0, 1, 5]) {
      dom.document.body.innerHTML = render(`${start}. 第一项\n\n1. 第二项\n\n1. 第三项`);
      const lists = dom.document.querySelectorAll("ol");
      assert.equal(lists.length, 1);
      assert.equal(lists[0].start, start);
      assert.equal(lists[0].querySelectorAll(":scope > li").length, 3);
    }
    dom.document.body.innerHTML = render("1. 第一项\n\n独立段落。\n\n5. 第五项\n6. 第六项");
    assert.deepEqual([...dom.document.querySelectorAll("ol")].map((list) => list.start), [1, 5]);
  } finally {
    await dom.close();
  }
});

test("嵌套列表使用各自的编号且保留后续说明", async () => {
  const dom = new Window();
  try {
    dom.document.body.innerHTML = render("3. 外层第一项\n\n   7. 内层第一项\n   8. 内层第二项\n\n   后续说明。\n\n4. 外层第二项\n\n   - 无序第一项\n   - 无序第二项");
    const outer = dom.document.querySelector(".answer-body > ol");
    assert.ok(outer);
    assert.equal(outer.getAttribute("start"), "3");
    const items = outer.querySelectorAll(":scope > li");
    assert.equal(items.length, 2);
    const inner = items[0].querySelector("ol");
    assert.ok(inner);
    assert.equal(inner.start, 7);
    assert.equal(inner.querySelectorAll(":scope > li").length, 2);
    assert.equal(inner.nextElementSibling?.textContent, "后续说明。");
    const unordered = items[1].querySelector("ul");
    assert.ok(unordered);
    assert.equal(unordered.hasAttribute("start"), false);
    assert.equal(unordered.querySelectorAll(":scope > li").length, 2);
  } finally {
    await dom.close();
  }
});

test("流式消息在各个截断位置都能渲染", () => {
  const text = readFileSync(new URL("./fixtures/ordered-list.md", import.meta.url), "utf8");
  for (let length = 0; length <= text.length; length += 1) {
    assert.doesNotThrow(() => render(text.slice(0, length)), `字符位置 ${length}`);
  }
});

test("任务列表保留完成标记和说明", async () => {
  const dom = new Window();
  try {
    for (const separator of ["\n", "\n\n"]) {
      dom.document.body.innerHTML = render(`- [x] 完成${separator}- [ ] 待办`);
      assert.deepEqual(
        [...dom.document.querySelectorAll("li")].map((item) => item.textContent),
        ["[x] 完成", "[ ] 待办"],
      );
    }
    assert.doesNotThrow(() => render("- [x]\n- [ ]"));
    dom.document.body.innerHTML = render("- [x] 完成\n\n  说明段落。\n\n- [ ] 待办");
    assert.equal(dom.document.querySelector("li > .answer-p")?.textContent, "[x] 完成");
    assert.equal(dom.document.querySelector("li > .answer-p + .answer-p")?.textContent, "说明段落。");
  } finally {
    await dom.close();
  }
});

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

test("clicking a web link hands it to the host instead of the default navigation", async () => {
  const dom = new Window({ url: "http://localhost/" });
  const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = dom.document.createElement("div");
  const view = createRoot(container as unknown as HTMLElement);
  const opened: string[] = [];
  try {
    await act(async () => view.render(createElement(MarkdownHost, {
      api: {
        canOpen: true,
        openHref: () => undefined,
        renderImage: () => null,
        renderWebsite: () => null,
        openLink: (url) => { opened.push(url); },
      },
      children: createElement(MarkdownBody, { text: "- **GitHub 仓库地址**：[https://github.com/morluto/rea](https://github.com/morluto/rea)" }),
    })));
    const link = container.querySelector("a");
    assert.ok(link instanceof dom.HTMLAnchorElement);
    const click = new dom.MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => { link.dispatchEvent(click); });
    assert.deepEqual(opened, ["https://github.com/morluto/rea"]);
    assert.equal(click.defaultPrevented, true);
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

test("a shell block without a terminal only copies, and non-shell code renders a B2-1 header bar with language and copy", () => {
  const shell = render("```sh\nls\n```");
  assert.match(shell, /aria-label="复制"/);
  assert.equal(shell.includes("在终端中运行"), false);
  const code = render("```ts\nconst a = 1;\n```", () => undefined);
  assert.equal(code.includes('data-answer-block="command"'), false);
  assert.equal(code.includes("在终端中运行"), false);
  assert.match(code, /class="answer-codeblock-bar"/);
  assert.match(code, /<span class="answer-codeblock-lang">ts<\/span>/);
  assert.match(code, /aria-label="复制"/);
  assert.ok(code.indexOf("answer-codeblock-bar") < code.indexOf('data-answer-block="code"'));
});
