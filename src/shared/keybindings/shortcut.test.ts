import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_RESOLVED_KEYBINDINGS, matchKeybinding } from "./defaults.ts";
import {
  detectShortcutPlatform,
  formatShortcutLabel,
  matchesShortcut,
  normalizePhysicalChord,
  parseShortcut,
  shortcutFromKeyboardEvent,
  type ShortcutKeyboardEvent,
} from "./shortcut.ts";

function keyEvent(patch: Partial<ShortcutKeyboardEvent> & { key: string }): ShortcutKeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...patch,
  };
}

test("parses standard and punctuation chords across modifiers", () => {
  assert.deepEqual(parseShortcut("mod+k"), {
    mod: true,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    key: "k",
  });
  assert.deepEqual(parseShortcut("Mod+Shift+P"), {
    mod: true,
    ctrl: false,
    meta: false,
    alt: false,
    shift: true,
    key: "p",
  });
  assert.equal(parseShortcut("mod+`")?.key, "`");
  assert.equal(parseShortcut("ctrl+alt+s")?.alt, true);
  assert.equal(parseShortcut("mod+shift+[")?.key, "[");
  assert.equal(parseShortcut("mod+shift+]")?.key, "]");
  assert.equal(parseShortcut("mod+1")?.key, "1");
  assert.equal(parseShortcut("mod+9")?.key, "9");
  assert.equal(parseShortcut("mod+shift+backspace")?.key, "backspace");
  assert.equal(parseShortcut("mod+shift+delete")?.key, "delete");
  assert.equal(parseShortcut("mod+shift+.")?.key, ".");
  assert.equal(parseShortcut("mod+,")?.key, ",");
  assert.equal(parseShortcut(""), null);
  assert.equal(parseShortcut("ctrl+shift"), null);
  assert.equal(parseShortcut("mod++k"), null);
  assert.equal(parseShortcut("mod++")?.key, "+");
  assert.equal(parseShortcut("mod++")?.shift, false);
  assert.deepEqual(parseShortcut("mod+{"), {
    mod: true,
    ctrl: false,
    meta: false,
    alt: false,
    shift: true,
    key: "[",
  });
});

test("mod maps to ctrlKey on Windows/Linux and metaKey on macOS", () => {
  assert.equal(detectShortcutPlatform({ platform: "Win32" }), "windows");
  assert.equal(detectShortcutPlatform({ platform: "MacIntel" }), "mac");
  assert.equal(detectShortcutPlatform({ platform: "Linux x86_64" }), "linux");

  assert.equal(matchesShortcut(keyEvent({ key: "k", ctrlKey: true }), "mod+k", "windows"), true);
  assert.equal(matchesShortcut(keyEvent({ key: "k", metaKey: true }), "mod+k", "windows"), false);
  assert.equal(matchesShortcut(keyEvent({ key: "k", metaKey: true }), "mod+k", "mac"), true);
  assert.equal(matchesShortcut(keyEvent({ key: "k", ctrlKey: true }), "mod+k", "mac"), false);
});

test("handles Backquote, BracketLeft/BracketRight, shifted punctuation, Digit1..9 via event.code fallback, and AltGraph guard", () => {
  // 中文输入法下反引号输出 ·，靠 Backquote 识别
  assert.equal(
    matchesShortcut(keyEvent({ key: "·", code: "Backquote", ctrlKey: true }), "mod+`", "windows"),
    true,
  );
  // 真实浏览器里按 Ctrl+Shift+[ 会报 key: "{" + code: "BracketLeft"
  assert.equal(
    matchesShortcut(
      keyEvent({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true }),
      "mod+shift+[",
      "windows",
    ),
    true,
  );
  assert.equal(
    matchesShortcut(
      keyEvent({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true }),
      "mod+shift+]",
      "mac",
    ),
    true,
  );
  // Ctrl+Shift+. 浏览器报 key: ">" + code: "Period"
  assert.equal(
    matchesShortcut(
      keyEvent({ key: ">", code: "Period", ctrlKey: true, shiftKey: true }),
      "mod+shift+.",
      "windows",
    ),
    true,
  );
  // AZERTY 布局下按顶排数字键 1 报 key: "&" + code: "Digit1" + shiftKey: false：必须命中 mod+1，绝不能误判为 mod+7
  const azertyCtrl1 = keyEvent({ key: "&", code: "Digit1", ctrlKey: true, shiftKey: false });
  assert.equal(matchesShortcut(azertyCtrl1, "mod+1", "windows"), true);
  assert.equal(matchesShortcut(azertyCtrl1, "mod+7", "windows"), false);
  assert.equal(
    matchKeybinding(azertyCtrl1, {}, DEFAULT_RESOLVED_KEYBINDINGS, "windows")?.command,
    "session.jump.1",
  );
  // 未按 Shift 的 Ctrl+= 不得误命中 mod++；按 Shift 的 Ctrl+Shift+= 可命中 mod+shift++
  assert.equal(
    matchesShortcut(keyEvent({ key: "=", code: "Equal", ctrlKey: true, shiftKey: false }), "mod++", "windows"),
    false,
  );
  assert.equal(
    matchesShortcut(keyEvent({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }), "mod+shift++", "windows"),
    true,
  );
  assert.equal(normalizePhysicalChord("mod++", "windows"), "ctrl++");
  assert.equal(normalizePhysicalChord("mod+shift++", "windows"), "ctrl+shift+=");
  assert.equal(normalizePhysicalChord("mod+{", "windows"), "ctrl+shift+[");
  assert.equal(
    matchesShortcut(keyEvent({ key: "ç", code: "Digit9", metaKey: true }), "mod+9", "mac"),
    true,
  );
  // macOS Option 改写字符（Option+S -> ß）回退到 KeyS，但 Dvorak 普通字母按布局识别
  assert.equal(
    matchesShortcut(
      keyEvent({ key: "ß", code: "KeyS", ctrlKey: true, altKey: true }),
      "ctrl+alt+s",
      "mac",
    ),
    true,
  );
  assert.equal(
    matchesShortcut(keyEvent({ key: "o", code: "KeyS", ctrlKey: true }), "mod+s", "windows"),
    false,
  );
  // Windows 波兰语等布局 AltGr 伪装为 Ctrl+Alt，必须被 AltGraph 守卫拦截
  assert.equal(
    matchesShortcut(
      keyEvent({
        key: "ś",
        code: "KeyS",
        ctrlKey: true,
        altKey: true,
        getModifierState: (mod) => mod === "AltGraph",
      }),
      "ctrl+alt+s",
      "windows",
    ),
    false,
  );
});

test("formats platform-aware labels and records KeyboardEvent into canonical mod+ strings", () => {
  assert.equal(formatShortcutLabel("mod+k", "windows"), "Ctrl+K");
  assert.equal(formatShortcutLabel("mod+shift+p", "windows"), "Ctrl+Shift+P");
  assert.equal(formatShortcutLabel("ctrl+alt+s", "windows"), "Ctrl+Alt+S");
  assert.equal(formatShortcutLabel("mod+shift+[", "windows"), "Ctrl+Shift+[");
  assert.equal(formatShortcutLabel("mod+shift+backspace", "windows"), "Ctrl+Shift+Backspace");

  assert.equal(formatShortcutLabel("mod+k", "mac"), "⌘K");
  assert.equal(formatShortcutLabel("mod+shift+p", "mac"), "⇧⌘P");
  assert.equal(formatShortcutLabel("ctrl+alt+s", "mac"), "⌃⌥S");

  assert.equal(
    shortcutFromKeyboardEvent(keyEvent({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }), "windows"),
    "mod+shift+k",
  );
  assert.equal(
    shortcutFromKeyboardEvent(keyEvent({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }), "mac"),
    "mod+shift+[",
  );
  assert.equal(
    shortcutFromKeyboardEvent(keyEvent({ key: "Control", code: "ControlLeft", ctrlKey: true }), "windows"),
    null,
  );

  assert.equal(normalizePhysicalChord("mod+k", "windows"), "ctrl+k");
  assert.equal(normalizePhysicalChord("ctrl+k", "windows"), "ctrl+k");
  assert.equal(normalizePhysicalChord("mod+k", "mac"), "meta+k");
  assert.equal(normalizePhysicalChord("meta+k", "mac"), "meta+k");
});
