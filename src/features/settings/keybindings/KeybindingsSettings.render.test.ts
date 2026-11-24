import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement, useState } from "react";
import type { createRoot as CreateRoot, Root } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import type { KeybindingRule } from "@/shared/keybindings";

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
installGlobal("HTMLButtonElement", dom.HTMLButtonElement);
installGlobal("HTMLInputElement", dom.HTMLInputElement);
installGlobal("SVGElement", dom.SVGElement);
installGlobal("Element", dom.Element);
installGlobal("Node", dom.Node);
installGlobal("navigator", dom.navigator);
installGlobal("MutationObserver", dom.MutationObserver);
installGlobal("getComputedStyle", dom.getComputedStyle.bind(dom));
installGlobal("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
installGlobal("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));

let server: ViteDevServer;
let createRoot: typeof CreateRoot;
let panelMod: typeof import("./KeybindingsPanel.tsx");

before(async () => {
  ({ createRoot } = await import("react-dom/client"));
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "error",
  });
  panelMod = (await server.ssrLoadModule(
    "/src/features/settings/keybindings/KeybindingsPanel.tsx",
  )) as unknown as typeof panelMod;
});

after(async () => {
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

async function mountPanel(initialRules: KeybindingRule[] = [], fileError: string | null = null) {
  const savedHistory: KeybindingRule[][] = [];
  let resetCalls = 0;
  let openJsonCalls = 0;
  let setBusyExternal: ((next: boolean) => void) | null = null;

  function Harness() {
    const [rules, setRules] = useState<KeybindingRule[]>(initialRules);
    const [busy, setBusy] = useState(false);
    setBusyExternal = setBusy;
    return createElement(panelMod.KeybindingsPanel, {
      userRules: rules,
      configPath: "C:\\Users\\admn\\.ai-workbench\\keybindings.json",
      fileError,
      busy,
      platform: "windows",
      onSaveRules: (next) => {
        savedHistory.push(next);
        setRules(next);
      },
      onResetAll: () => {
        resetCalls += 1;
        setRules([]);
      },
      onOpenConfigFile: () => {
        openJsonCalls += 1;
      },
    });
  }

  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as unknown as Parameters<typeof dom.document.body.appendChild>[0]);
  const root: Root = createRoot(host);
  await act(async () => {
    root.render(createElement(Harness));
  });

  return {
    host,
    savedHistory,
    setBusy(next: boolean) {
      return act(async () => {
        setBusyExternal?.(next);
      });
    },
    get resetCalls() {
      return resetCalls;
    },
    get openJsonCalls() {
      return openJsonCalls;
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("renders parse error banner, header actions, conflict warning, and filter chips", async () => {
  const view = await mountPanel(
    [{ command: "board.toggle", key: "ctrl+b" }],
    "Expected ',' or ']' after array element at line 4",
  );
  try {
    const errorBanner = view.host.querySelector("[data-keybindings-file-error]");
    assert.ok(errorBanner);
    assert.equal(errorBanner.textContent?.includes("Expected ',' or ']'"), true);

    const openBtn = view.host.querySelector("[data-keybindings-open-json]") as HTMLButtonElement;
    assert.equal(openBtn.getAttribute("title"), "C:\\Users\\admn\\.ai-workbench\\keybindings.json");
    await act(async () => openBtn.click());
    assert.equal(view.openJsonCalls, 1);

    const conflictBadge = view.host.querySelector("[data-keybinding-conflict='board.toggle']");
    assert.ok(conflictBadge);
    assert.equal(conflictBadge.getAttribute("title")?.includes("显示/隐藏侧边栏"), true);

    const customizedBadge = view.host.querySelector("[data-keybinding-customized='board.toggle']");
    assert.ok(customizedBadge);

    // 点击「仅看冲突」只剩互相冲突的两条命令
    const conflictChip = view.host.querySelector("[data-keybindings-filter='conflicts']") as HTMLButtonElement;
    await act(async () => conflictChip.click());
    assert.equal(view.host.querySelectorAll("[data-keybinding-row]").length, 2);

    // 点击「全部恢复默认」
    const resetAllBtn = view.host.querySelector("[data-keybindings-reset-all]") as HTMLButtonElement;
    await act(async () => resetAllBtn.click());
    assert.equal(view.resetCalls, 1);
  } finally {
    await view.unmount();
  }
});

test("interactive shortcut recording: Escape cancels, Enter saves, Clear unbinds, and Reset restores default", async () => {
  const view = await mountPanel([]);
  try {
    const recordBtn = view.host.querySelector("[data-keybinding-record='sidebar.toggle']") as HTMLButtonElement;
    await act(async () => recordBtn.click());
    assert.ok(view.host.querySelector("[data-keybinding-recorder='sidebar.toggle']"));

    // 按 Ctrl+J 预览，再按 Escape 取消
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.KeyboardEvent("keydown", { key: "j", code: "KeyJ", ctrlKey: true, bubbles: true }),
      );
    });
    assert.equal(view.host.querySelector("[data-keybinding-recorded-preview]")?.textContent, "Ctrl+J");
    await act(async () => {
      dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(view.host.querySelector("[data-keybinding-recorder='sidebar.toggle']"), null);
    assert.equal(view.host.querySelector("[data-keybinding-kbd='sidebar.toggle']")?.textContent, "Ctrl+B");

    // 重新录制 Ctrl+J，按 Enter 保存
    const recordAgain = view.host.querySelector("[data-keybinding-record='sidebar.toggle']") as HTMLButtonElement;
    await act(async () => recordAgain.click());
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.KeyboardEvent("keydown", { key: "j", code: "KeyJ", ctrlKey: true, bubbles: true }),
      );
    });
    await act(async () => {
      dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.equal(view.host.querySelector("[data-keybinding-kbd='sidebar.toggle']")?.textContent, "Ctrl+J");
    assert.ok(view.host.querySelector("[data-keybinding-customized='sidebar.toggle']"));

    // 点击「清除快捷键」解绑
    const clearBtn = view.host.querySelector("[data-keybinding-clear='sidebar.toggle']") as HTMLButtonElement;
    await act(async () => clearBtn.click());
    assert.ok(view.host.querySelector("[data-keybinding-unbound='sidebar.toggle']"));

    // 点击「恢复默认」还原 Ctrl+B
    const resetBtn = view.host.querySelector("[data-keybinding-reset='sidebar.toggle']") as HTMLButtonElement;
    await act(async () => resetBtn.click());
    assert.equal(view.host.querySelector("[data-keybinding-kbd='sidebar.toggle']")?.textContent, "Ctrl+B");
  } finally {
    await view.unmount();
  }
});

function setInputValue(input: HTMLInputElement, value: string) {
  const protoSetter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set;
  protoSetter?.call(input, value);
  input.dispatchEvent(new dom.InputEvent("input", { bubbles: true }) as unknown as Event);
}

test("inline when editor validates unknown variables, inserts quick chips, and saves valid expressions", async () => {
  const view = await mountPanel([]);
  try {
    const whenTrigger = view.host.querySelector("[data-keybinding-when-trigger='sidebar.toggle']") as HTMLButtonElement;
    await act(async () => whenTrigger.click());

    const input = view.host.querySelector("[data-keybinding-when-input='sidebar.toggle']") as HTMLInputElement;
    const saveBtn = view.host.querySelector("[data-keybinding-when-save='sidebar.toggle']") as HTMLButtonElement;
    assert.ok(input);

    // 点击快捷变量芯片插入 !terminalFocus
    const chip = view.host.querySelector("[data-keybinding-when-chip='!terminalFocus']") as HTMLButtonElement;
    await act(async () => chip.click());
    assert.equal(input.value, "!terminalFocus");
    assert.equal(saveBtn.disabled, false);

    // 输入未知变量触发错误校验并禁用保存按钮
    await act(async () => {
      setInputValue(input, "notARealVariable && sessionActive");
    });
    assert.ok(view.host.querySelector("[data-keybinding-when-error]"));
    assert.equal(
      view.host.querySelector("[data-keybinding-when-error]")?.textContent?.includes("notARealVariable"),
      true,
    );
    assert.equal(saveBtn.disabled, true);

    // 输入 false 提示使用清除按钮而非将 when 设为 false
    await act(async () => {
      setInputValue(input, "false");
    });
    assert.equal(
      view.host.querySelector("[data-keybinding-when-error]")?.textContent,
      "要停用快捷键请点击清除按钮，不要将 when 设为 false",
    );
    assert.equal(saveBtn.disabled, true);

    // 修正为合法表达式后保存
    await act(async () => {
      setInputValue(input, "!terminalFocus && !modalOpen");
    });
    assert.equal(saveBtn.disabled, false);
    await act(async () => saveBtn.click());

    assert.equal(
      view.host.querySelector("[data-keybinding-when-trigger='sidebar.toggle']")?.textContent,
      "!terminalFocus && !modalOpen",
    );

    // 搜索栏按修改后的 when 条件筛选
    const searchInput = view.host.querySelector("[data-keybindings-search]") as HTMLInputElement;
    await act(async () => {
      setInputValue(searchInput, "!modalOpen");
    });
    const rows = Array.from(view.host.querySelectorAll("[data-keybinding-row]")).map((el) =>
      el.getAttribute("data-keybinding-row"),
    );
    assert.equal(rows.includes("sidebar.toggle"), true);
    assert.equal(rows.includes("session.jump.1"), true);
    assert.equal(rows.includes("settings.open"), false);
  } finally {
    await view.unmount();
  }
});

test("recording a new shortcut after intentionally clearing defaultWhen keeps global empty when and preserves secondaryDefaults", async () => {
  // commandMenu.toggle has defaultWhen = "!terminalFocus" and secondaryDefaults = [{ key: "mod+shift+p" }]
  const view = await mountPanel([]);
  try {
    // 1) Open when editor on commandMenu.toggle and clear when to "" (global)
    const whenTrigger = view.host.querySelector(
      "[data-keybinding-when-trigger='commandMenu.toggle']",
    ) as HTMLButtonElement;
    await act(async () => whenTrigger.click());
    const whenInput = view.host.querySelector(
      "[data-keybinding-when-input='commandMenu.toggle']",
    ) as HTMLInputElement;
    const whenSave = view.host.querySelector(
      "[data-keybinding-when-save='commandMenu.toggle']",
    ) as HTMLButtonElement;
    await act(async () => {
      setInputValue(whenInput, "");
    });
    await act(async () => whenSave.click());

    assert.equal(
      view.host.querySelector("[data-keybinding-when-trigger='commandMenu.toggle']")?.textContent,
      "全局生效",
    );

    // 2) Now record a new primary key Ctrl+J -> intentionally cleared when ("") AND Ctrl+Shift+P secondary must both stay intact!
    const recordBtn = view.host.querySelector(
      "[data-keybinding-record='commandMenu.toggle']",
    ) as HTMLButtonElement;
    await act(async () => recordBtn.click());
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.KeyboardEvent("keydown", { key: "j", code: "KeyJ", ctrlKey: true, bubbles: true }),
      );
    });
    await act(async () => {
      dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    assert.equal(
      view.host.querySelector("[data-keybinding-kbd='commandMenu.toggle']")?.textContent,
      "Ctrl+J",
    );
    assert.equal(
      view.host.querySelector("[data-keybinding-when-trigger='commandMenu.toggle']")?.textContent,
      "全局生效",
    );
    const rowText =
      view.host.querySelector("[data-keybinding-row='commandMenu.toggle']")?.textContent ?? "";
    assert.match(rowText, /Ctrl\+Shift\+P/);
  } finally {
    await view.unmount();
  }
});

test("filtering out an active recording row cancels recording, and Enter does not commit while busy", async () => {
  const view = await mountPanel([]);
  try {
    const recordBtn = view.host.querySelector(
      "[data-keybinding-record='sidebar.toggle']",
    ) as HTMLButtonElement;
    await act(async () => recordBtn.click());
    assert.ok(view.host.querySelector("[data-keybinding-recorder='sidebar.toggle']"));

    await act(async () => {
      dom.window.dispatchEvent(
        new dom.KeyboardEvent("keydown", { key: "j", code: "KeyJ", ctrlKey: true, bubbles: true }),
      );
    });
    assert.equal(view.host.querySelector("[data-keybinding-recorded-preview]")?.textContent, "Ctrl+J");

    // While busy is true, pressing Enter must NOT commit onSaveRules
    await view.setBusy(true);
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    assert.equal(view.savedHistory.length, 0);
    assert.ok(view.host.querySelector("[data-keybinding-recorder='sidebar.toggle']"));
    await view.setBusy(false);

    // Filter out sidebar.toggle via search -> recording must cancel and release window capture listener
    const searchInput = view.host.querySelector("[data-keybindings-search]") as HTMLInputElement;
    await act(async () => {
      setInputValue(searchInput, "settings.open");
    });
    assert.equal(view.host.querySelector("[data-keybinding-row='sidebar.toggle']"), null);

    let keyEventDefaultPrevented = false;
    await act(async () => {
      const ev = new dom.KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        bubbles: true,
        cancelable: true,
      });
      dom.window.dispatchEvent(ev);
      keyEventDefaultPrevented = ev.defaultPrevented;
    });
    assert.equal(keyEventDefaultPrevented, false);

    // Clearing search filter shows sidebar.toggle is no longer recording and did not save Ctrl+J
    await act(async () => {
      setInputValue(searchInput, "");
    });
    assert.equal(view.host.querySelector("[data-keybinding-recorder='sidebar.toggle']"), null);
    assert.equal(view.host.querySelector("[data-keybinding-kbd='sidebar.toggle']")?.textContent, "Ctrl+B");
    assert.equal(view.savedHistory.length, 0);
  } finally {
    await view.unmount();
  }
});
