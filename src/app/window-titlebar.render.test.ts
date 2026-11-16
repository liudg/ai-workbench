import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import type { WindowTitlebarState } from "./use-window-titlebar.ts";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
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

let server: ViteDevServer;
let WindowTitlebar: typeof import("./WindowTitlebar.tsx").WindowTitlebar;
let UpdateTitlebarPill: typeof import("../features/updates/UpdateTitlebarPill.tsx").UpdateTitlebarPill;
let updateStore: typeof import("../features/updates/update-store.ts");
let updater: typeof import("../lib/native/updater.ts");
let AttentionPill: typeof import("../shared/attention/AttentionPill.tsx").AttentionPill;
let attentionPill: typeof import("../shared/attention/attention.ts").attentionPill;

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  WindowTitlebar = (await server.ssrLoadModule("/src/app/WindowTitlebar.tsx")).WindowTitlebar;
  UpdateTitlebarPill = (await server.ssrLoadModule("/src/features/updates/UpdateTitlebarPill.tsx")).UpdateTitlebarPill;
  updateStore = (await server.ssrLoadModule("/src/features/updates/update-store.ts")) as typeof updateStore;
  updater = (await server.ssrLoadModule("/src/lib/native/updater.ts")) as typeof updater;
  AttentionPill = (await server.ssrLoadModule("/src/shared/attention/AttentionPill.tsx")).AttentionPill;
  attentionPill = (await server.ssrLoadModule("/src/shared/attention/attention.ts").then((m) => m)).attentionPill;
});

after(async () => {
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

async function render(node: ReturnType<typeof createElement>) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(node);
  });
  return {
    host,
    async rerender(next: ReturnType<typeof createElement>) {
      await act(async () => {
        root.render(next);
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("web preview renders Variant A immersive breadcrumb bar without dead window caption buttons", async () => {
  const calls: string[] = [];
  const chrome: WindowTitlebarState = {
    nativeControls: false,
    maximized: false,
    contextLabel: "ai-workbench",
    minimize: () => calls.push("minimize"),
    toggleMaximize: () => calls.push("toggleMaximize"),
    close: () => calls.push("close"),
    startDrag: () => calls.push("startDrag"),
  };
  const view = await render(
    createElement(WindowTitlebar, {
      chrome,
      trailing: chrome.nativeControls ? createElement(UpdateTitlebarPill) : undefined,
    }),
  );
  const bar = view.host.querySelector("[data-window-titlebar]");
  assert.ok(bar instanceof dom.HTMLElement);
  assert.equal(bar.children.length, 1);
  assert.equal(bar.className.includes("h-8"), true);
  assert.equal(bar.className.includes("z-40"), true);
  assert.ok(bar.querySelector("[data-sidebar-toggle]"));
  assert.equal(bar.querySelector("[data-window-context]")?.textContent, "ai-workbench");
  assert.equal(bar.querySelector("[data-window-action]"), null);

  await act(async () => {
    bar.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1, clientX: 40, clientY: 12 }));
    dom.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 80, clientY: 12 }));
    dom.dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true }));
    bar.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, detail: 2 }));
  });
  assert.deepEqual(calls, []);
  await view.unmount();
});

test("desktop immersive titlebar waits for pointer movement before dragging so double-click maximize is never swallowed", async () => {
  const calls: string[] = [];
  const makeChrome = (maximized: boolean): WindowTitlebarState => ({
    nativeControls: true,
    maximized,
    contextLabel: "ai-workbench",
    minimize: () => calls.push("minimize"),
    toggleMaximize: () => calls.push("toggleMaximize"),
    close: () => calls.push("close"),
    startDrag: () => calls.push("startDrag"),
  });

  const view = await render(createElement(WindowTitlebar, { chrome: makeChrome(false) }));
  const bar = view.host.querySelector("[data-window-titlebar]");
  assert.ok(bar instanceof dom.HTMLElement);
  assert.equal(bar.className.includes("h-8"), true);
  assert.equal(bar.className.includes("z-40"), true);
  assert.equal(bar.querySelector("img[src='/favicon.png']"), null);
  assert.equal(bar.querySelector("[data-window-command]"), null);

  const toggle = bar.querySelector("[data-sidebar-toggle]");
  assert.ok(toggle instanceof dom.HTMLButtonElement);
  assert.equal(toggle.className.includes("h-6"), true);
  assert.equal(toggle.className.includes("w-6"), true);
  assert.equal(view.host.querySelector("[data-window-context]")?.textContent, "ai-workbench");

  // Stationary click + double-click triggers toggleMaximize without premature startDrag.
  await act(async () => {
    bar.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1, clientX: 120, clientY: 14 }));
    dom.dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true }));
    bar.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, detail: 2, clientX: 120, clientY: 14 }));
  });
  assert.deepEqual(calls, ["toggleMaximize"]);

  // Press and move >= 3px triggers native window drag once.
  await act(async () => {
    bar.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1, clientX: 120, clientY: 14 }));
    dom.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 126, clientY: 14 }));
    dom.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 140, clientY: 18 }));
    dom.dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true }));
  });
  assert.deepEqual(calls, ["toggleMaximize", "startDrag"]);

  const minBtn = view.host.querySelector("[data-window-action='minimize']");
  const maxBtn = view.host.querySelector("[data-window-action='maximize']");
  const closeBtn = view.host.querySelector("[data-window-action='close']");
  assert.ok(minBtn instanceof dom.HTMLButtonElement);
  assert.ok(maxBtn instanceof dom.HTMLButtonElement);
  assert.ok(closeBtn instanceof dom.HTMLButtonElement);
  assert.equal(minBtn.className.includes("h-7"), true);
  assert.equal(minBtn.className.includes("w-9"), true);
  assert.equal(maxBtn.getAttribute("aria-label"), "最大化");

  await act(async () => {
    minBtn.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1, clientX: 300, clientY: 12 }));
    dom.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 320, clientY: 12 }));
    dom.dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true }));
    minBtn.click();
    maxBtn.click();
    closeBtn.click();
  });
  assert.deepEqual(calls, [
    "toggleMaximize",
    "startDrag",
    "minimize",
    "toggleMaximize",
    "close",
  ]);

  await view.rerender(createElement(WindowTitlebar, { chrome: makeChrome(true) }));
  assert.equal(
    view.host.querySelector("[data-window-action='maximize']")?.getAttribute("aria-label"),
    "向下还原",
  );

  await view.unmount();
});

test("non-compact AttentionPill renders 12px (text-xs) soft-tinted capsule while compact stays dot-only", async () => {
  const pill = attentionPill({ state: "needs-input", ask: "approval", unread: true, updatedAt: 1 });
  const full = await render(createElement(AttentionPill, { pill }));
  const fullEl = full.host.querySelector("[data-attention='approval']");
  assert.ok(fullEl);
  assert.equal(fullEl.className.includes("bg-wb-warn-soft"), true);
  assert.equal(fullEl.className.includes("text-xs"), true);
  assert.equal(fullEl.className.includes("rounded-full"), true);
  await full.unmount();

  const compact = await render(createElement(AttentionPill, { pill, compact: true }));
  const compactEl = compact.host.querySelector("[data-attention='approval']");
  assert.ok(compactEl);
  assert.equal(compactEl.className.includes("bg-wb-warn-soft"), false);
  assert.equal(compactEl.textContent, "");
  await compact.unmount();
});

test("UpdateTitlebarPill opens update dialog on click without triggering window drag and hides on dismiss", async () => {
  await updater.resetUpdaterForTest();
  updateStore.resetUpdateStoreForTest();

  const calls: string[] = [];
  const chrome: WindowTitlebarState = {
    nativeControls: true,
    maximized: false,
    contextLabel: null,
    minimize: () => calls.push("minimize"),
    toggleMaximize: () => calls.push("toggleMaximize"),
    close: () => calls.push("close"),
    startDrag: () => calls.push("startDrag"),
  };

  const view = await render(
    createElement(WindowTitlebar, {
      chrome,
      trailing: createElement(UpdateTitlebarPill),
    }),
  );
  assert.equal(view.host.querySelector("[data-update-pill]"), null);

  await act(async () => {
    await updateStore.checkUpdates(false, {
      isDesktop: true,
      endpoint: () => "https://downloads.example.com/latest.json",
      checkRemote: async () =>
        ({
          version: "0.2.95",
          body: "notes",
          download: async () => {},
          install: async () => {},
          close: async () => {},
        }) as never,
      relaunchApp: async () => {},
    });
  });

  const pillBtn = view.host.querySelector("[data-update-pill='available']");
  assert.ok(pillBtn instanceof dom.HTMLButtonElement);
  assert.equal(pillBtn.textContent, "新版本 v0.2.95");
  assert.equal(updateStore.getUpdateStateSnapshot().dialogOpen, false);

  await act(async () => {
    pillBtn.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1, clientX: 220, clientY: 12 }));
    dom.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 250, clientY: 12 }));
    dom.dispatchEvent(new dom.MouseEvent("mouseup", { bubbles: true }));
    pillBtn.click();
  });
  assert.deepEqual(calls, []);
  assert.equal(updateStore.getUpdateStateSnapshot().dialogOpen, true);

  await act(async () => {
    updateStore.dismissUpdate();
  });
  assert.equal(view.host.querySelector("[data-update-pill]"), null);

  await view.unmount();
  await updater.resetUpdaterForTest();
  updateStore.resetUpdateStoreForTest();
});
