import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
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
installGlobal("Element", dom.Element);
installGlobal("Node", dom.Node);
installGlobal("navigator", dom.navigator);
installGlobal("MutationObserver", dom.MutationObserver);
installGlobal("ResizeObserver", dom.ResizeObserver);
installGlobal("getComputedStyle", dom.getComputedStyle.bind(dom));
installGlobal("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
installGlobal("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));

let server: ViteDevServer;
let PreviewChrome: typeof import("./PreviewChrome.tsx").PreviewChrome;

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  PreviewChrome = (
    (await server.ssrLoadModule("/src/features/panel/files/PreviewChrome.tsx")) as typeof import("./PreviewChrome.tsx")
  ).PreviewChrome;
});

after(async () => {
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

test("the open capsule keeps direct open and the menu on separate halves, and the folder button toggles the tree", async () => {
  const opened: string[] = [];
  let toggles = 0;
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(
      createElement(PreviewChrome, {
        path: "src/app.ts",
        root: "C:/work/demo",
        projectId: "p",
        treeOpen: true,
        onToggleTree: () => {
          toggles += 1;
        },
        onSelectFile: () => undefined,
        onSearch: () => undefined,
        searchEnabled: true,
        chooseApp: true,
        onOpenWith: (mode) => {
          opened.push(mode);
        },
      }),
    );
  });

  const openDefault = dom.document.querySelector("[data-open-with-default]");
  const menuButton = dom.document.querySelector("[data-open-with-menu-button]");
  assert.ok(openDefault instanceof dom.HTMLButtonElement);
  assert.ok(menuButton instanceof dom.HTMLButtonElement);
  assert.notEqual(openDefault, menuButton);

  await act(async () => {
    openDefault.click();
  });
  assert.deepEqual(opened, ["default"]);
  assert.equal(dom.document.querySelector("[data-open-with-menu]"), null);

  await act(async () => {
    menuButton.click();
  });
  assert.deepEqual(opened, ["default"]);
  const menu = dom.document.querySelector("[data-open-with-menu]");
  assert.ok(menu);
  assert.equal(menu.textContent?.includes("用默认应用打开"), true);
  assert.equal(menu.textContent?.includes("选择应用…"), true);

  const choose = dom.document.querySelector('[data-open-with-action="choose"]');
  assert.ok(choose instanceof dom.HTMLButtonElement);
  await act(async () => {
    choose.click();
  });
  assert.deepEqual(opened, ["default", "choose"]);
  assert.equal(dom.document.querySelector("[data-open-with-menu]"), null);

  const tree = dom.document.querySelector("[data-toggle-file-tree]");
  assert.ok(tree instanceof dom.HTMLButtonElement);
  assert.equal(tree.getAttribute("aria-pressed"), "true");
  await act(async () => {
    tree.click();
  });
  assert.equal(toggles, 1);
  assert.deepEqual(opened, ["default", "choose"]);

  await act(async () => {
    root.unmount();
  });
  host.remove();
});
