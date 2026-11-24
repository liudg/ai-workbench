// 快捷键设置页的纯视图模型、搜索筛选与用户规则变更计算。无副作用，可直接在 Node 单测运行。

import { conflictsByCommand, detectKeybindingConflicts } from "../../../shared/keybindings/conflicts.ts";
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_COMMANDS,
  KEYBINDING_COMMAND_BY_ID,
  KEYBINDING_GROUP_LABELS,
  resolveKeybindings,
} from "../../../shared/keybindings/defaults.ts";
import {
  detectShortcutPlatform,
  formatShortcutLabel,
  normalizePhysicalChord,
} from "../../../shared/keybindings/shortcut.ts";
import type {
  KeybindingCommandGroup,
  KeybindingCommandMeta,
  KeybindingRule,
  ResolvedKeybindingRule,
  ShortcutPlatform,
} from "../../../shared/keybindings/types.ts";

export const KEYBINDINGS_PAGE = {
  nav: "快捷键",
  title: "键盘快捷键",
  subtitle: "自定义全局命令的按键绑定与触发条件（when 表达式），修改实时写入 keybindings.json。",
  searchPlaceholder: "搜索命令名称、ID、快捷键或 when 条件…",
  filterConflicts: "仅看冲突",
  filterModified: "仅看已修改",
  openJson: "打开 keybindings.json",
  resetAll: "全部恢复默认",
  customizedBadge: "已自定义",
  unbound: "未绑定",
  record: "录制",
  recordingPrompt: "按下组合键…",
  recordingHint: "Enter 保存 · Esc 取消",
  clearShortcut: "清除快捷键",
  resetCommand: "恢复默认",
  alwaysActive: "全局生效",
  editWhen: "编辑条件",
  emptyMatch: "没有匹配的快捷键命令",
} as const;

export const QUICK_WHEN_CHIPS: readonly { label: string; expr: string }[] = [
  { label: "!terminalFocus", expr: "!terminalFocus" },
  { label: "!inputFocus", expr: "!inputFocus" },
  { label: "sessionActive", expr: "sessionActive" },
  { label: "projectActive", expr: "projectActive" },
  { label: "panelOpen", expr: "panelOpen" },
  { label: "!commandMenuOpen", expr: "!commandMenuOpen" },
  { label: "!modalOpen", expr: "!modalOpen" },
  { label: "composerFocus", expr: "composerFocus" },
  { label: "sidebarOpen", expr: "sidebarOpen" },
  { label: "settingsOpen", expr: "settingsOpen" },
  { label: "boardOpen", expr: "boardOpen" },
  { label: "isDesktop", expr: "isDesktop" },
  { label: "isWeb", expr: "isWeb" },
];

export interface KeybindingDisplayRow {
  id: string;
  title: string;
  group: KeybindingCommandGroup;
  groupLabel: string;
  /** 主快捷键原始值（如 `"mod+k"`），未绑定时为 `""`。 */
  effectiveKey: string;
  /** 主快捷键在当前平台的展示文案（如 `"Ctrl+K"` / `"⌘K"`），未绑定时为 `""`。 */
  shortcutLabel: string;
  /** 附加和弦（如 `Ctrl+Shift+P`、`Ctrl+Shift+Backspace`）。 */
  secondaryLabels: string[];
  effectiveWhen: string;
  defaultKey: string;
  defaultWhen: string;
  isCustomized: boolean;
  /** 与当前命令冲突的其他命令展示名称列表。 */
  conflictTitles: string[];
  conflictIds: string[];
}

export interface KeybindingFilterInput {
  query: string;
  onlyConflicts: boolean;
  onlyModified: boolean;
}

const GROUP_DISPLAY_ORDER: readonly KeybindingCommandGroup[] = [
  "general",
  "session",
  "navigation",
  "panel",
];

function touchesCommand(rule: KeybindingRule, commandId: string): boolean {
  const cmd = rule.command.trim();
  return cmd === commandId || cmd === `-${commandId}`;
}

export function buildKeybindingDisplayRows(
  userRules: readonly KeybindingRule[],
  platform: ShortcutPlatform = detectShortcutPlatform(),
  commands: readonly KeybindingCommandMeta[] = KEYBINDING_COMMANDS,
): {
  rows: KeybindingDisplayRow[];
  resolved: ResolvedKeybindingRule[];
  conflictCount: number;
  modifiedCount: number;
} {
  const resolved = resolveKeybindings(DEFAULT_KEYBINDINGS, userRules, platform);
  const conflicts = detectKeybindingConflicts(resolved, platform);
  const conflictMap = conflictsByCommand(conflicts);

  const rows: KeybindingDisplayRow[] = commands.map((meta) => {
    const activeForCmd = resolved.filter((rule) => rule.command === meta.id && rule.parsed);
    const userActive = activeForCmd.filter((rule) => rule.source === "user");
    const primary =
      userActive.length > 0 ? userActive[userActive.length - 1] : (activeForCmd[0] ?? null);
    const others = activeForCmd.filter((rule) => rule !== primary);

    const isCustomized = userRules.some((rule) => touchesCommand(rule, meta.id));
    const conflictIds = conflictMap.get(meta.id) ?? [];
    const conflictTitles = conflictIds.map((id) => KEYBINDING_COMMAND_BY_ID.get(id)?.title ?? id);

    const effectiveKey = primary?.key ?? "";
    const effectiveWhen =
      primary?.when ?? (activeForCmd.length === 0 && !isCustomized ? (meta.defaultWhen ?? "") : "");

    return {
      id: meta.id,
      title: meta.title,
      group: meta.group,
      groupLabel: KEYBINDING_GROUP_LABELS[meta.group],
      effectiveKey,
      shortcutLabel: effectiveKey ? formatShortcutLabel(primary?.parsed ?? effectiveKey, platform) : "",
      secondaryLabels: others
        .map((rule) => formatShortcutLabel(rule.parsed ?? rule.key, platform))
        .filter(Boolean),
      effectiveWhen,
      defaultKey: meta.defaultKey,
      defaultWhen: meta.defaultWhen ?? "",
      isCustomized,
      conflictTitles,
      conflictIds,
    };
  });

  const conflictCount = rows.filter((row) => row.conflictIds.length > 0).length;
  const modifiedCount = rows.filter((row) => row.isCustomized).length;
  return { rows, resolved, conflictCount, modifiedCount };
}

export function filterKeybindingRows(
  rows: readonly KeybindingDisplayRow[],
  filter: KeybindingFilterInput,
): KeybindingDisplayRow[] {
  const needle = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.onlyConflicts && row.conflictIds.length === 0) return false;
    if (filter.onlyModified && !row.isCustomized) return false;
    if (!needle) return true;
    const haystacks = [
      row.title,
      row.id,
      row.effectiveKey,
      row.shortcutLabel,
      ...row.secondaryLabels,
      row.effectiveWhen,
      row.groupLabel,
    ];
    return haystacks.some((text) => text.toLowerCase().includes(needle));
  });
}

export function groupKeybindingRows(
  rows: readonly KeybindingDisplayRow[],
): { group: KeybindingCommandGroup; label: string; rows: KeybindingDisplayRow[] }[] {
  const buckets = new Map<KeybindingCommandGroup, KeybindingDisplayRow[]>();
  for (const row of rows) {
    const list = buckets.get(row.group);
    if (list) list.push(row);
    else buckets.set(row.group, [row]);
  }
  const sections: { group: KeybindingCommandGroup; label: string; rows: KeybindingDisplayRow[] }[] = [];
  for (const group of GROUP_DISPLAY_ORDER) {
    const list = buckets.get(group);
    if (list && list.length > 0) {
      sections.push({ group, label: KEYBINDING_GROUP_LABELS[group], rows: list });
    }
  }
  return sections;
}

export function resetCommandToDefault(
  userRules: readonly KeybindingRule[],
  commandId: string,
): KeybindingRule[] {
  return userRules.filter((rule) => !touchesCommand(rule, commandId));
}

export function unbindCommandShortcut(
  userRules: readonly KeybindingRule[],
  meta: Pick<KeybindingCommandMeta, "id" | "defaultKey" | "secondaryDefaults">,
): KeybindingRule[] {
  const base = resetCommandToDefault(userRules, meta.id);
  const hasDefaults = Boolean(meta.defaultKey || meta.secondaryDefaults?.length);
  if (!hasDefaults) return base;
  return [...base, { command: meta.id, key: "" }];
}

export function setCommandShortcutAndWhen(
  userRules: readonly KeybindingRule[],
  meta: Pick<KeybindingCommandMeta, "id" | "defaultKey" | "defaultWhen" | "secondaryDefaults">,
  nextKey: string,
  nextWhen: string | undefined,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): KeybindingRule[] {
  const cleanKey = nextKey.trim();
  const cleanWhen = nextWhen?.trim() ?? "";
  if (!cleanKey) {
    return unbindCommandShortcut(userRules, meta);
  }

  const base = resetCommandToDefault(userRules, meta.id);
  const secondaryDefaults = meta.secondaryDefaults ?? [];
  const hasSecondary = secondaryDefaults.length > 0;
  const nextChord = normalizePhysicalChord(cleanKey, platform);
  const sameAsPrimaryDefault =
    Boolean(meta.defaultKey) &&
    nextChord === normalizePhysicalChord(meta.defaultKey, platform) &&
    cleanWhen === (meta.defaultWhen ?? "");

  if (sameAsPrimaryDefault) {
    return base;
  }

  const nextRule: KeybindingRule = cleanWhen
    ? { command: meta.id, key: cleanKey, when: cleanWhen }
    : { command: meta.id, key: cleanKey };

  const hasDefaults = Boolean(meta.defaultKey || hasSecondary);
  if (!hasDefaults) {
    return [...base, nextRule];
  }
  if (!hasSecondary) {
    return [...base, { command: meta.id, key: "" }, nextRule];
  }

  const unbounds: KeybindingRule[] = [];
  if (meta.defaultKey) {
    unbounds.push({
      command: `-${meta.id}`,
      key: meta.defaultKey,
      ...(meta.defaultWhen ? { when: meta.defaultWhen } : {}),
    });
  }
  for (const extra of secondaryDefaults) {
    if (!extra.key) continue;
    if (nextChord && normalizePhysicalChord(extra.key, platform) === nextChord) {
      unbounds.push({
        command: `-${meta.id}`,
        key: extra.key,
        ...(extra.when ? { when: extra.when } : {}),
      });
    }
  }
  return [...base, ...unbounds, nextRule];
}

/** 预览在某条命令录制新按键时的即时冲突提示。 */
export function previewRecordingConflicts(
  userRules: readonly KeybindingRule[],
  meta: Pick<KeybindingCommandMeta, "id" | "defaultKey" | "defaultWhen" | "secondaryDefaults">,
  candidateKey: string,
  candidateWhen: string | undefined,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string[] {
  if (!candidateKey.trim()) return [];
  const nextUser = setCommandShortcutAndWhen(userRules, meta, candidateKey, candidateWhen, platform);
  const resolved = resolveKeybindings(DEFAULT_KEYBINDINGS, nextUser, platform);
  const conflicts = detectKeybindingConflicts(resolved, platform);
  const ids = conflictsByCommand(conflicts).get(meta.id) ?? [];
  return ids.map((id) => KEYBINDING_COMMAND_BY_ID.get(id)?.title ?? id);
}
