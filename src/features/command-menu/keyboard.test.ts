import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_KEYBINDINGS, resolveKeybindings } from "../../shared/keybindings/defaults.ts";
import {
  deleteShortcutMenu,
  jumpSection,
  moveCursor,
  parseSessionJumpIndex,
  resolveGlobalCommand,
  sectionStarts,
} from "./keyboard.ts";

const chord = {
  key: "k",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
};

test("resolveGlobalCommand matches open chords (Mod+K and Mod+Shift+P) per platform", () => {
  const winRules = resolveKeybindings(DEFAULT_KEYBINDINGS, [], "windows");
  const macRules = resolveKeybindings(DEFAULT_KEYBINDINGS, [], "mac");

  assert.equal(
    resolveGlobalCommand({ ...chord, ctrlKey: true, key: "k" }, {}, winRules, "windows")?.command,
    "commandMenu.toggle",
  );
  assert.equal(
    resolveGlobalCommand({ ...chord, metaKey: true, key: "K" }, {}, macRules, "mac")?.command,
    "commandMenu.toggle",
  );
  assert.equal(
    resolveGlobalCommand({ ...chord, ctrlKey: true, shiftKey: true, key: "p" }, {}, winRules, "windows")?.command,
    "commandMenu.toggle",
  );
  assert.equal(
    resolveGlobalCommand({ ...chord, ctrlKey: true, shiftKey: true, key: "k" }, {}, winRules, "windows"),
    null,
  );
  assert.equal(resolveGlobalCommand({ ...chord, key: "k" }, {}, winRules, "windows"), null);
  assert.equal(
    resolveGlobalCommand({ ...chord, ctrlKey: true, altKey: true, key: "k" }, {}, winRules, "windows"),
    null,
  );
});

test("resolveGlobalCommand matches sidebar, quick open, new session, delete, and terminal chords", () => {
  const winRules = resolveKeybindings(DEFAULT_KEYBINDINGS, [], "windows");
  const macRules = resolveKeybindings(DEFAULT_KEYBINDINGS, [], "mac");

  assert.equal(
    resolveGlobalCommand({ ...chord, ctrlKey: true, key: "b" }, {}, winRules, "windows")?.command,
    "sidebar.toggle",
  );
  assert.equal(
    resolveGlobalCommand({ ...chord, metaKey: true, key: "B" }, {}, macRules, "mac")?.command,
    "sidebar.toggle",
  );
  assert.equal(
    resolveGlobalCommand({ ...chord, ctrlKey: true, key: "p" }, {}, winRules, "windows")?.command,
    "quickOpen.toggle",
  );
  assert.equal(
    resolveGlobalCommand({ ...chord, metaKey: true, key: "P" }, {}, macRules, "mac")?.command,
    "quickOpen.toggle",
  );
  assert.equal(
    resolveGlobalCommand({ ...chord, ctrlKey: true, shiftKey: true, key: "o" }, {}, winRules, "windows")?.command,
    "session.new",
  );
  assert.equal(
    resolveGlobalCommand(
      { ...chord, ctrlKey: true, shiftKey: true, key: "Delete" },
      { sessionActive: true, inputFocus: false },
      winRules,
      "windows",
    )?.command,
    "session.delete",
  );
  assert.equal(
    resolveGlobalCommand(
      { ...chord, ctrlKey: true, shiftKey: true, key: "Backspace" },
      { sessionActive: true, inputFocus: false },
      winRules,
      "windows",
    )?.command,
    "session.delete",
  );
  assert.equal(
    resolveGlobalCommand(
      { ...chord, ctrlKey: true, key: "`", code: "Backquote" },
      { panelOpen: true },
      winRules,
      "windows",
    )?.command,
    "terminal.toggle",
  );
  assert.deepEqual(deleteShortcutMenu(false), { open: true, drill: "delete" });
  assert.deepEqual(deleteShortcutMenu(true), { open: true, drill: "delete" });
});

test("arrows stop at the ends", () => {
  assert.equal(moveCursor(0, 3, "ArrowUp"), 0);
  assert.equal(moveCursor(2, 3, "ArrowDown"), 2);
  assert.equal(moveCursor(1, 3, "ArrowDown"), 2);
});

test("tab jumps to the next section and wraps", () => {
  const starts = sectionStarts(["suggested", "suggested", "settings", "thread"]);
  assert.deepEqual(starts, [0, 2, 3]);
  assert.equal(jumpSection(starts, 0, 1), 2);
  assert.equal(jumpSection(starts, 3, 1), 0);
  assert.equal(jumpSection(starts, 0, -1), 3);
});

test("resolveGlobalCommand matches sideChat.toggle by physical KeyS and rejects AltGraph", () => {
  const winRules = resolveKeybindings(DEFAULT_KEYBINDINGS, [], "windows");
  const macRules = resolveKeybindings(
    DEFAULT_KEYBINDINGS,
    [{ command: "sideChat.toggle", key: "mod+alt+s" }],
    "mac",
  );
  const base = { ...chord, key: "s", code: "KeyS", ctrlKey: true, altKey: true };
  assert.equal(
    resolveGlobalCommand(base, { sessionActive: true }, winRules, "windows")?.command,
    "sideChat.toggle",
  );
  // macOS 上 Option 把 key 改成别的字符，物理键位 KeyS 仍能命中。
  assert.equal(
    resolveGlobalCommand({ ...base, ctrlKey: false, metaKey: true, key: "ß" }, { sessionActive: true }, macRules, "mac")
      ?.command,
    "sideChat.toggle",
  );
  assert.equal(
    resolveGlobalCommand({ ...base, altKey: false }, { sessionActive: true }, winRules, "windows"),
    null,
  );
  // AltGr+S 在波兰语布局里打出 ś。
  assert.equal(
    resolveGlobalCommand(
      { ...base, key: "ś", getModifierState: (key) => key === "AltGraph" },
      { sessionActive: true },
      winRules,
      "windows",
    ),
    null,
  );
});

test("resolveGlobalCommand dispatches session.prev/next, session.jump.1..9, and respects terminalFocus / modalOpen", () => {
  const rules = resolveKeybindings(DEFAULT_KEYBINDINGS, [], "windows");

  // Mod+K 在终端聚焦时不拦截（保留给终端清屏），Mod+Shift+P 仍打开命令菜单
  assert.equal(
    resolveGlobalCommand({ ...chord, ctrlKey: true, key: "k" }, { terminalFocus: true }, rules, "windows"),
    null,
  );
  assert.equal(
    resolveGlobalCommand(
      { ...chord, ctrlKey: true, shiftKey: true, key: "P" },
      { terminalFocus: true },
      rules,
      "windows",
    )?.command,
    "commandMenu.toggle",
  );

  // Mod+Shift+[ / ] 切换上/下会话
  assert.equal(
    resolveGlobalCommand(
      { ...chord, ctrlKey: true, shiftKey: true, key: "{", code: "BracketLeft" },
      {},
      rules,
      "windows",
    )?.command,
    "session.prev",
  );
  assert.equal(
    resolveGlobalCommand(
      { ...chord, ctrlKey: true, shiftKey: true, key: "}", code: "BracketRight" },
      {},
      rules,
      "windows",
    )?.command,
    "session.next",
  );

  // Mod+1..9 跳转对应会话，但在命令菜单或弹窗开启时不触发
  const jump1 = resolveGlobalCommand(
    { ...chord, ctrlKey: true, key: "1", code: "Digit1" },
    { commandMenuOpen: false, modalOpen: false },
    rules,
    "windows",
  );
  assert.equal(jump1?.command, "session.jump.1");
  assert.equal(parseSessionJumpIndex(jump1!.command), 1);
  assert.equal(parseSessionJumpIndex("session.prev"), null);

  assert.equal(
    resolveGlobalCommand(
      { ...chord, ctrlKey: true, key: "1", code: "Digit1" },
      { commandMenuOpen: true, modalOpen: false },
      rules,
      "windows",
    ),
    null,
  );
});
