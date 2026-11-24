// 快捷键字符串解析、KeyboardEvent 匹配、平台显示文案格式化与按键录制。

import type { ParsedShortcut, ShortcutPlatform } from "./types.ts";

export interface ShortcutKeyboardEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?: (key: string) => boolean;
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  escape: "escape",
  return: "enter",
  enter: "enter",
  del: "delete",
  delete: "delete",
  bs: "backspace",
  backspace: "backspace",
  space: "space",
  spacebar: "space",
  " ": "space",
  tab: "tab",
  up: "up",
  arrowup: "up",
  down: "down",
  arrowdown: "down",
  left: "left",
  arrowleft: "left",
  right: "right",
  arrowright: "right",
  pageup: "pageup",
  pgup: "pageup",
  pagedown: "pagedown",
  pgdn: "pagedown",
  home: "home",
  end: "end",
  insert: "insert",
  ins: "insert",
  backquote: "`",
  grave: "`",
  "`": "`",
  bracketleft: "[",
  "[": "[",
  bracketright: "]",
  "]": "]",
  comma: ",",
  ",": ",",
  period: ".",
  ".": ".",
  slash: "/",
  "/": "/",
  backslash: "\\",
  "\\": "\\",
  semicolon: ";",
  ";": ";",
  quote: "'",
  "'": "'",
  minus: "-",
  "-": "-",
  equal: "=",
  equals: "=",
  "=": "=",
  plus: "+",
  "+": "+",
};

/** Shift 组合下浏览器 `event.key` 变成符号时，还原回底层标点或数字键。 */
const SHIFTED_KEY_TO_BASE: Readonly<Record<string, string>> = {
  "~": "`",
  "{": "[",
  "}": "]",
  "<": ",",
  ">": ".",
  "?": "/",
  "|": "\\",
  ":": ";",
  "\"": "'",
  "_": "-",
  "!": "1",
  "@": "2",
  "#": "3",
  "$": "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
};

const MODIFIER_EVENT_KEYS: ReadonlySet<string> = new Set([
  "control",
  "shift",
  "alt",
  "meta",
  "altgraph",
  "capslock",
  "numlock",
  "scrolllock",
  "fn",
  "fnlock",
  "os",
  "super",
  "hyper",
]);

const MODIFIER_CODES: ReadonlySet<string> = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "CapsLock",
]);

export function detectShortcutPlatform(
  nav?: { platform?: string; userAgent?: string } | null,
): ShortcutPlatform {
  const source = nav !== undefined ? nav : typeof navigator !== "undefined" ? navigator : null;
  const raw = `${source?.platform ?? ""} ${source?.userAgent ?? ""}`.toLowerCase();
  if (raw.includes("mac") || raw.includes("iphone") || raw.includes("ipad")) return "mac";
  if (raw.includes("linux")) return "linux";
  return "windows";
}

function normalizeShortcutKeyToken(
  raw: string,
): { key: string; impliedShift: boolean } | null {
  const lower = raw.toLowerCase();
  if (KEY_ALIASES[lower]) return { key: KEY_ALIASES[lower], impliedShift: false };
  if (SHIFTED_KEY_TO_BASE[lower]) return { key: SHIFTED_KEY_TO_BASE[lower], impliedShift: true };
  if (/^[a-z0-9]$/.test(lower)) return { key: lower, impliedShift: false };
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return { key: lower, impliedShift: false };
  return null;
}

function splitShortcutTokens(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "+") return ["+"];
  if (trimmed.endsWith("++")) {
    const head = trimmed.slice(0, -2);
    if (!head) return null;
    const prefix = head.split("+");
    if (prefix.some((part) => !part.trim())) return null;
    return [...prefix.map((part) => part.trim()), "+"];
  }
  const parts = trimmed.split("+");
  if (parts.some((part) => !part.trim())) return null;
  return parts.map((part) => part.trim());
}

export function parseShortcut(shortcut: string): ParsedShortcut | null {
  const tokens = splitShortcutTokens(shortcut);
  if (!tokens || tokens.length === 0) return null;

  let mod = false;
  let ctrl = false;
  let meta = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].toLowerCase();
    const isLast = i === tokens.length - 1;
    if (!isLast) {
      if (token === "mod" || token === "cmdorctrl" || token === "commandorcontrol") {
        mod = true;
        continue;
      }
      if (token === "ctrl" || token === "control") {
        ctrl = true;
        continue;
      }
      if (token === "meta" || token === "cmd" || token === "command" || token === "win" || token === "super") {
        meta = true;
        continue;
      }
      if (token === "alt" || token === "opt" || token === "option") {
        alt = true;
        continue;
      }
      if (token === "shift") {
        shift = true;
        continue;
      }
      return null;
    }
    if (
      token === "mod" ||
      token === "cmdorctrl" ||
      token === "commandorcontrol" ||
      token === "ctrl" ||
      token === "control" ||
      token === "meta" ||
      token === "cmd" ||
      token === "command" ||
      token === "win" ||
      token === "super" ||
      token === "alt" ||
      token === "opt" ||
      token === "option" ||
      token === "shift"
    ) {
      return null;
    }
    const normalized = normalizeShortcutKeyToken(token);
    if (!normalized) return null;
    key = normalized.key;
    if (normalized.impliedShift) shift = true;
  }

  if (!key) return null;
  return { mod, ctrl, meta, alt, shift, key };
}

function codeToCanonicalKey(code: string | undefined): string | null {
  if (!code) return null;
  if (code.startsWith("Key") && code.length === 4) {
    const ch = code.slice(3).toLowerCase();
    if (ch >= "a" && ch <= "z") return ch;
  }
  if (code.startsWith("Digit") && code.length === 6) {
    const digit = code.slice(5);
    if (digit >= "0" && digit <= "9") return digit;
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase();
  switch (code) {
    case "Backquote":
      return "`";
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Backslash":
      return "\\";
    case "Semicolon":
      return ";";
    case "Quote":
      return "'";
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "Backspace":
      return "backspace";
    case "Delete":
      return "delete";
    case "Enter":
    case "NumpadEnter":
      return "enter";
    case "Escape":
      return "escape";
    case "Space":
      return "space";
    case "Tab":
      return "tab";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "Home":
      return "home";
    case "End":
      return "end";
    case "PageUp":
      return "pageup";
    case "PageDown":
      return "pagedown";
    case "Insert":
      return "insert";
    default:
      return null;
  }
}

function keyFromEventKey(rawKey: string, shiftKey: boolean): string | null {
  if (!rawKey) return null;
  if (rawKey === " ") return "space";
  const lower = rawKey.toLowerCase();
  if (lower === "dead" || lower === "process" || lower === "unidentified") return null;
  if (MODIFIER_EVENT_KEYS.has(lower)) return null;
  if (shiftKey && lower === "+") return "+";
  if (shiftKey && SHIFTED_KEY_TO_BASE[rawKey]) return SHIFTED_KEY_TO_BASE[rawKey];
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if (/^[a-z0-9]$/.test(lower)) return lower;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower;
  return null;
}

/** 将 ParsedShortcut 解析为指定平台上的物理修饰键需求。 */
function resolvePlatformModifiers(
  parsed: ParsedShortcut,
  platform: ShortcutPlatform,
): { ctrl: boolean; meta: boolean; alt: boolean; shift: boolean } {
  if (platform === "mac") {
    return {
      ctrl: parsed.ctrl,
      meta: parsed.meta || parsed.mod,
      alt: parsed.alt,
      shift: parsed.shift,
    };
  }
  return {
    ctrl: parsed.ctrl || parsed.mod,
    meta: parsed.meta,
    alt: parsed.alt,
    shift: parsed.shift,
  };
}

/** 归一化到当前平台上的物理和弦标识，如 Windows 下 `mod+k` 与 `ctrl+k` 同为 `ctrl+k`。 */
export function normalizePhysicalChord(
  shortcut: string | ParsedShortcut,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string | null {
  const parsed = typeof shortcut === "string" ? parseShortcut(shortcut) : shortcut;
  if (!parsed) return null;
  const mods = resolvePlatformModifiers(parsed, platform);
  const shiftedBase = SHIFTED_KEY_TO_BASE[parsed.key];
  const effectiveShift = mods.shift || Boolean(shiftedBase);
  const baseKey = shiftedBase ?? parsed.key;
  const parts: string[] = [];
  if (mods.ctrl) parts.push("ctrl");
  if (mods.meta) parts.push("meta");
  if (mods.alt) parts.push("alt");
  if (effectiveShift) parts.push("shift");
  const normalizedKey = baseKey === "+" && effectiveShift ? "=" : baseKey;
  parts.push(normalizedKey);
  return parts.join("+");
}

function formatCanonicalShortcut(parsed: ParsedShortcut): string {
  const parts: string[] = [];
  if (parsed.mod) parts.push("mod");
  if (parsed.ctrl) parts.push("ctrl");
  if (parsed.meta) parts.push("meta");
  if (parsed.alt) parts.push("alt");
  if (parsed.shift) parts.push("shift");
  parts.push(parsed.key);
  return parts.join("+");
}

export function matchesShortcut(
  event: ShortcutKeyboardEvent,
  shortcut: string | ParsedShortcut,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): boolean {
  if (event.repeat) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.getModifierState?.("AltGraph")) return false;

  const parsed = typeof shortcut === "string" ? parseShortcut(shortcut) : shortcut;
  if (!parsed) return false;

  const expected = resolvePlatformModifiers(parsed, platform);
  if (
    Boolean(event.ctrlKey) !== expected.ctrl ||
    Boolean(event.metaKey) !== expected.meta ||
    Boolean(event.altKey) !== expected.alt ||
    Boolean(event.shiftKey) !== expected.shift
  ) {
    return false;
  }

  const byKey = keyFromEventKey(event.key, event.shiftKey);
  const byCode = codeToCanonicalKey(event.code);

  // 普通 ASCII 字母优先尊重键盘布局（Dvorak/Colemak）；仅在 Option/IME 改写导致非 ASCII 时回退到物理键位。
  if (byKey && /^[a-z]$/.test(byKey)) {
    return byKey === parsed.key;
  }
  if (byKey === parsed.key) return true;
  if (parsed.key === "=" && event.shiftKey && event.key === "+") return true;
  if (parsed.key === "+" && (event.key === "+" || (event.shiftKey && byCode === "="))) return true;
  if (byCode && byCode === parsed.key) return true;
  return false;
}

/** 从浏览器 `KeyboardEvent` 录制出规范化的 `"mod+..."` 字符串；纯修饰键按压返回 `null`。 */
export function shortcutFromKeyboardEvent(
  event: ShortcutKeyboardEvent,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.getModifierState?.("AltGraph")) return null;
  if (event.code && MODIFIER_CODES.has(event.code)) return null;
  if (event.key && MODIFIER_EVENT_KEYS.has(event.key.toLowerCase())) return null;

  const byKey = keyFromEventKey(event.key, event.shiftKey);
  const byCode = codeToCanonicalKey(event.code);

  let key: string | null = null;
  if (byKey && /^[a-z]$/.test(byKey)) {
    key = byKey;
  } else if (
    byCode &&
    (/^[0-9]$/.test(byCode) ||
      byCode === "`" ||
      byCode === "[" ||
      byCode === "]" ||
      byCode === "," ||
      byCode === "." ||
      byCode === "/" ||
      byCode === "\\" ||
      byCode === ";" ||
      byCode === "'" ||
      byCode === "-" ||
      byCode === "=")
  ) {
    key = byCode;
  } else {
    key = byKey ?? byCode;
  }

  if (!key) return null;

  const mod = platform === "mac" ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
  const ctrl = platform === "mac" ? Boolean(event.ctrlKey) : false;
  const meta = platform === "mac" ? false : Boolean(event.metaKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);

  return formatCanonicalShortcut({ mod, ctrl, meta, alt, shift, key });
}

const DISPLAY_KEY_LABELS: Readonly<Record<string, string>> = {
  escape: "Esc",
  enter: "Enter",
  delete: "Delete",
  backspace: "Backspace",
  space: "Space",
  tab: "Tab",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  insert: "Insert",
};

function formatDisplayKey(key: string): string {
  if (DISPLAY_KEY_LABELS[key]) return DISPLAY_KEY_LABELS[key];
  if (/^[a-z]$/.test(key)) return key.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase();
  return key;
}

/** 按目标平台格式化人类可读快捷键，如 Windows 下 `"Ctrl+K"`，macOS 下 `"⌘K"`。 */
export function formatShortcutLabel(
  shortcut: string | ParsedShortcut | null | undefined,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  if (!shortcut) return "";
  const parsed = typeof shortcut === "string" ? parseShortcut(shortcut) : shortcut;
  if (!parsed) return typeof shortcut === "string" ? shortcut : "";

  const mods = resolvePlatformModifiers(parsed, platform);
  const keyLabel = formatDisplayKey(parsed.key);

  if (platform === "mac") {
    const symbols: string[] = [];
    if (mods.ctrl) symbols.push("⌃");
    if (mods.alt) symbols.push("⌥");
    if (mods.shift) symbols.push("⇧");
    if (mods.meta) symbols.push("⌘");
    return `${symbols.join("")}${keyLabel}`;
  }

  const parts: string[] = [];
  if (mods.ctrl) parts.push("Ctrl");
  if (mods.meta) parts.push(platform === "windows" ? "Win" : "Super");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  parts.push(keyLabel);
  return parts.join("+");
}
