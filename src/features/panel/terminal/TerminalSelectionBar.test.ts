import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import type { TextSnippetDraft } from "../../../shared/text-snippet.ts";

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
installGlobal("MouseEvent", dom.MouseEvent);
installGlobal("KeyboardEvent", dom.KeyboardEvent);
installGlobal("navigator", dom.navigator);
installGlobal("getComputedStyle", dom.getComputedStyle.bind(dom));
installGlobal("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
installGlobal("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));

let server: ViteDevServer;
let TerminalViewMod: typeof import("./TerminalView.tsx");

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    logLevel: "error",
  });
  TerminalViewMod = (await server.ssrLoadModule(
    "/src/features/panel/terminal/TerminalView.tsx",
  )) as typeof import("./TerminalView.tsx");
});

after(async () => {
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

test("TerminalSelectionBar shows on mouseup, sends snippet to chat, and dismisses on Escape or scroll", async () => {
  const selectionListeners = new Set<() => void>();
  const scrollListeners = new Set<() => void>();
  let selected = "";
  let pos: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;

  const fakeTerm = {
    cols: 80,
    rows: 24,
    buffer: { active: { viewportY: 0 } },
    hasSelection: () => selected.length > 0,
    getSelection: () => selected,
    getSelectionPosition: () => pos,
    clearSelection: () => {
      selected = "";
      pos = undefined;
      for (const fn of selectionListeners) fn();
    },
    focus: () => undefined,
    onSelectionChange: (fn: () => void) => {
      selectionListeners.add(fn);
      return { dispose: () => selectionListeners.delete(fn) };
    },
    onScroll: (fn: () => void) => {
      scrollListeners.add(fn);
      return { dispose: () => scrollListeners.delete(fn) };
    },
  };

  const added: TextSnippetDraft[] = [];
  const terminalRoot = dom.document.createElement("div");
  terminalRoot.setAttribute("data-terminal-view", "");
  const viewport = dom.document.createElement("div");
  viewport.className = "xterm-viewport";
  const child = dom.document.createElement("div");
  child.className = "xterm-screen";
  terminalRoot.appendChild(viewport);
  terminalRoot.appendChild(child);
  dom.document.body.appendChild(terminalRoot);

  const mount = dom.document.createElement("div");
  dom.document.body.appendChild(mount);
  const root = createRoot(mount as unknown as HTMLElement);
  const rootRef = { current: terminalRoot as unknown as HTMLElement };

  await act(async () => {
    root.render(
      createElement(TerminalViewMod.TerminalSelectionBar, {
        rootRef,
        term: fakeTerm as never,
        title: "终端",
        suppressed: false,
        onAddToChat: (draft) => added.push(draft),
      }),
    );
  });

  // 1. 按下鼠标并拖选，松开后出现浮动工具条
  await act(async () => {
    child.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 40, clientY: 60 }));
    selected = "cargo test failed\r\nat line 2";
    pos = { start: { x: 0, y: 11 }, end: { x: 9, y: 12 } };
    for (const fn of selectionListeners) fn();
  });
  assert.equal(dom.document.querySelector("[data-selection-menu]"), null);

  await act(async () => {
    dom.window.dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 160, clientY: 120 }));
  });

  const menu = dom.document.querySelector("[data-selection-menu]");
  assert.ok(menu);
  const addBtn = menu.querySelector('[data-selection-action="add"]') as HTMLButtonElement | null;
  const copyBtn = menu.querySelector('[data-selection-action="copy"]') as HTMLButtonElement | null;
  assert.ok(addBtn);
  assert.ok(copyBtn);
  assert.equal(addBtn.textContent, "添加到对话");
  assert.equal(copyBtn.textContent, "复制");

  // 2. 点击「添加到对话」发出草稿并清空选区与工具条
  await act(async () => {
    addBtn.click();
  });
  assert.equal(added.length, 1);
  assert.equal(added[0]?.path, "终端");
  assert.equal(added[0]?.start, 12);
  assert.equal(added[0]?.end, 13);
  assert.equal(added[0]?.quote, "```terminal:12-13\ncargo test failed\nat line 2\n```");
  assert.equal(dom.document.querySelector("[data-selection-menu]"), null);

  // 3. 再次选中后，按 Escape 收起工具条
  await act(async () => {
    child.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
    selected = "hello";
    pos = { start: { x: 0, y: 0 }, end: { x: 5, y: 0 } };
    dom.window.dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 80, clientY: 40 }));
  });
  assert.ok(dom.document.querySelector("[data-selection-menu]"));

  await act(async () => {
    dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(dom.document.querySelector("[data-selection-menu]"), null);

  // 4. 再次选中后，终端滚动时收起工具条
  await act(async () => {
    child.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
    selected = "scroll test";
    pos = { start: { x: 0, y: 3 }, end: { x: 11, y: 3 } };
    dom.window.dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 80, clientY: 40 }));
  });
  assert.ok(dom.document.querySelector("[data-selection-menu]"));

  await act(async () => {
    for (const fn of scrollListeners) fn();
  });
  assert.equal(dom.document.querySelector("[data-selection-menu]"), null);

  // 5. 拖动 `.xterm-viewport` 滚动条（不在 `.xterm-screen` 内）松开鼠标时，绝不能把旧选区重新弹出工具条
  await act(async () => {
    viewport.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 790, clientY: 30 }));
    dom.window.dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 790, clientY: 160 }));
  });
  assert.equal(dom.document.querySelector("[data-selection-menu]"), null);

  await act(async () => {
    root.unmount();
  });
  mount.remove();
  terminalRoot.remove();
});
