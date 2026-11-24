// 全局快捷键引擎的共享类型。不依赖任何 feature。

export interface KeybindingRule {
  command: string;
  key: string;
  when?: string;
}

export const WHEN_CONTEXT_VARIABLES = [
  "terminalFocus",
  "composerFocus",
  "inputFocus",
  "commandMenuOpen",
  "modalOpen",
  "sidebarOpen",
  "panelOpen",
  "settingsOpen",
  "boardOpen",
  "sessionActive",
  "projectActive",
  "isDesktop",
  "isWeb",
] as const;

export type WhenContextVariable = (typeof WHEN_CONTEXT_VARIABLES)[number];

export type WhenContext = Record<WhenContextVariable, boolean>;

export type ShortcutPlatform = "mac" | "windows" | "linux";

export interface ParsedShortcut {
  /** 跨平台主修饰键：macOS 为 Cmd (metaKey)，Windows/Linux 为 Ctrl (ctrlKey)。 */
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /** 归一化后的主键标识，如 "k"、"p"、"`"、"["、"]"、"1".."9"、"backspace"、"delete"。 */
  key: string;
}

export interface ResolvedKeybindingRule {
  /** 在合并后规则数组中的序号，越靠后优先级越高（last matching rule wins）。 */
  index: number;
  command: string;
  key: string;
  when?: string;
  source: "default" | "user";
  parsed: ParsedShortcut | null;
}

export type KeybindingCommandGroup = "general" | "session" | "navigation" | "panel";

export interface KeybindingSecondaryDefault {
  key: string;
  when?: string;
}

export interface KeybindingCommandMeta {
  id: string;
  title: string;
  group: KeybindingCommandGroup;
  defaultKey: string;
  defaultWhen?: string;
  secondaryDefaults?: readonly KeybindingSecondaryDefault[];
}

export interface KeybindingsSnapshot {
  path: string;
  rules: KeybindingRule[];
  error?: string | null;
}

export interface KeybindingConflict {
  /** 归一化后的物理按键和弦标识。 */
  chord: string;
  ruleA: ResolvedKeybindingRule;
  ruleB: ResolvedKeybindingRule;
}
