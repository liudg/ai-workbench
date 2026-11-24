import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement } from "react";
import type { createRoot as CreateRoot, Root } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

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
installGlobal("HTMLButtonElement", dom.HTMLButtonElement);
installGlobal("SVGElement", dom.SVGElement);
installGlobal("Element", dom.Element);
installGlobal("Node", dom.Node);
installGlobal("MouseEvent", dom.MouseEvent);
installGlobal("KeyboardEvent", dom.KeyboardEvent);
installGlobal("navigator", dom.navigator);
installGlobal("MutationObserver", dom.MutationObserver);
installGlobal("getComputedStyle", dom.getComputedStyle.bind(dom));
installGlobal("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
installGlobal("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));

let server: ViteDevServer;
let createRoot: typeof CreateRoot;
let rowMod: typeof import("./sessions/SessionRow.tsx");
let holdMod: typeof import("./useModHold.ts");
let daemonMod: typeof import("../../lib/daemon/index.ts");

before(async () => {
  ({ createRoot } = await import("react-dom/client"));
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  const agents = await server.ssrLoadModule("/src/features/agents/index.ts");
  agents.seedAgents({}, []);
  rowMod = (await server.ssrLoadModule("/src/features/sidebar/sessions/SessionRow.tsx")) as unknown as typeof rowMod;
  holdMod = (await server.ssrLoadModule("/src/features/sidebar/useModHold.ts")) as unknown as typeof holdMod;
  daemonMod = (await server.ssrLoadModule("/src/lib/daemon/index.ts")) as unknown as typeof daemonMod;
});

after(async () => {
  daemonMod?.daemon.stop();
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

test("useModHold reveals data-session-jump-badge after holding Mod alone and cancels on keyup or chord", async () => {
  function Harness() {
    const held = holdMod.useModHold(30);
    return createElement(rowMod.SessionRow, {
      task: {
        id: "t1",
        projectId: "p1",
        agent: "codex-cli",
        title: "第一个会话",
        status: "completed",
        attention: { state: "idle", unread: false, updatedAt: 1 },
        updatedAt: 1,
        pinned: false,
        archived: false,
        parentTaskId: null,
      },
      active: false,
      now: 1000,
      depth: 0,
      last: false,
      subtasks: 0,
      collapsed: false,
      jumpIndex: held ? 1 : undefined,
      onToggle: () => {},
    });
  }

  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(Harness));
  });

  assert.equal(host.querySelector("[data-session-jump-badge]"), null);

  await act(async () => {
    dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(host.querySelector("[data-session-jump-badge]")?.textContent, "1");

  // 按下其他键立即取消显示角标
  await act(async () => {
    dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  });
  assert.equal(host.querySelector("[data-session-jump-badge]"), null);

  // 再次长按显示，失焦时立即隐藏
  await act(async () => {
    dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(host.querySelector("[data-session-jump-badge]")?.textContent, "1");

  await act(async () => {
    dom.window.dispatchEvent(new dom.Event("blur"));
  });
  assert.equal(host.querySelector("[data-session-jump-badge]"), null);

  // Ctrl+Click (mousedown before timer fires) cancels hold timer so badge never sticks
  await act(async () => {
    dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true }));
    dom.window.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(host.querySelector("[data-session-jump-badge]"), null);

  // contextmenu also cancels active hold state immediately
  await act(async () => {
    dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(host.querySelector("[data-session-jump-badge]")?.textContent, "1");
  await act(async () => {
    dom.window.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true }));
  });
  assert.equal(host.querySelector("[data-session-jump-badge]"), null);

  await act(async () => {
    root.unmount();
  });
  host.remove();
});
