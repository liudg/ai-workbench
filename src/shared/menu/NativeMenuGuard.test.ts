import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import { findEditableElement } from "../dom/editable.ts";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
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
installGlobal("HTMLInputElement", dom.HTMLInputElement);
installGlobal("HTMLTextAreaElement", dom.HTMLTextAreaElement);
installGlobal("Element", dom.Element);
installGlobal("Node", dom.Node);
installGlobal("MouseEvent", dom.MouseEvent);
installGlobal("navigator", dom.navigator);
installGlobal("getComputedStyle", dom.getComputedStyle.bind(dom));
installGlobal("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
installGlobal("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));

let server: ViteDevServer;
let mod: typeof import("./NativeMenuGuard.tsx");

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "error",
  });
  mod = (await server.ssrLoadModule("/src/shared/menu/NativeMenuGuard.tsx")) as typeof import("./NativeMenuGuard.tsx");
});

after(async () => {
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

test("findEditableElement ignores xterm helper textarea, terminal view, and non-text inputs while matching regular inputs", () => {
  const input = dom.document.createElement("input");
  input.type = "text";
  const hiddenInput = dom.document.createElement("input");
  hiddenInput.type = "hidden";
  const imageInput = dom.document.createElement("input");
  imageInput.type = "image";
  const textarea = dom.document.createElement("textarea");
  const xtermTextarea = dom.document.createElement("textarea");
  xtermTextarea.className = "xterm-helper-textarea";

  const terminalRoot = dom.document.createElement("div");
  terminalRoot.setAttribute("data-terminal-view", "");
  const terminalTextarea = dom.document.createElement("textarea");
  terminalTextarea.className = "xterm-helper-textarea";
  terminalRoot.appendChild(terminalTextarea);

  assert.equal(findEditableElement(input as unknown as EventTarget), input);
  assert.equal(findEditableElement(hiddenInput as unknown as EventTarget), null);
  assert.equal(findEditableElement(imageInput as unknown as EventTarget), null);
  assert.equal(findEditableElement(textarea as unknown as EventTarget), textarea);
  assert.equal(findEditableElement(xtermTextarea as unknown as EventTarget), null);
  assert.equal(findEditableElement(terminalTextarea as unknown as EventTarget), null);
});

test("NativeMenuGuard lets contextmenu events inside [data-terminal-view] propagate to TerminalView", async () => {
  const mount = dom.document.createElement("div");
  dom.document.body.appendChild(mount);
  const root = createRoot(mount as unknown as HTMLElement);

  let terminalReceived = 0;
  const terminalView = dom.document.createElement("div");
  terminalView.setAttribute("data-terminal-view", "");
  const helper = dom.document.createElement("textarea");
  helper.className = "xterm-helper-textarea";
  terminalView.appendChild(helper);
  terminalView.addEventListener("contextmenu", () => {
    terminalReceived += 1;
  });
  dom.document.body.appendChild(terminalView);

  const plainTextarea = dom.document.createElement("textarea");
  let plainBubbled = 0;
  plainTextarea.addEventListener("contextmenu", () => {
    plainBubbled += 1;
  });
  dom.document.body.appendChild(plainTextarea);

  await act(async () => {
    root.render(createElement(mod.NativeMenuGuard));
  });

  await act(async () => {
    const ev = new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 });
    helper.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
  });
  assert.equal(terminalReceived, 1);
  assert.equal(dom.document.querySelector("[data-context-menu]"), null);

  await act(async () => {
    const ev = new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 70 });
    plainTextarea.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
  });
  assert.equal(plainBubbled, 0);
  assert.ok(dom.document.querySelector("[data-context-menu]"));

  await act(async () => {
    root.unmount();
  });
  mount.remove();
  terminalView.remove();
  plainTextarea.remove();
});
