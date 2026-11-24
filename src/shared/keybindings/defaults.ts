// 全局默认快捷键目录、用户规则合并、运行时派发匹配与文案解析。

import {
  detectShortcutPlatform,
  formatShortcutLabel,
  matchesShortcut,
  normalizePhysicalChord,
  parseShortcut,
  type ShortcutKeyboardEvent,
} from "./shortcut.ts";
import type {
  KeybindingCommandGroup,
  KeybindingCommandMeta,
  KeybindingRule,
  ResolvedKeybindingRule,
  ShortcutPlatform,
  WhenContext,
} from "./types.ts";
import { evaluateWhen } from "./when.ts";

export const KEYBINDING_GROUP_LABELS: Readonly<Record<KeybindingCommandGroup, string>> = {
  general: "通用与系统",
  session: "对话",
  navigation: "导航与切换",
  panel: "面板与工具",
};

const JUMP_COMMANDS: readonly KeybindingCommandMeta[] = Array.from({ length: 9 }, (_, idx) => {
  const n = idx + 1;
  return {
    id: `session.jump.${n}`,
    title: `跳转到第 ${n} 个对话`,
    group: "navigation" as const,
    defaultKey: `mod+${n}`,
    defaultWhen: "!commandMenuOpen && !modalOpen",
  };
});

export const KEYBINDING_COMMANDS: readonly KeybindingCommandMeta[] = [
  {
    id: "commandMenu.toggle",
    title: "打开命令菜单",
    group: "general",
    defaultKey: "mod+k",
    defaultWhen: "!terminalFocus",
    secondaryDefaults: [{ key: "mod+shift+p" }],
  },
  {
    id: "sidebar.toggle",
    title: "显示/隐藏侧边栏",
    group: "general",
    defaultKey: "mod+b",
  },
  {
    id: "settings.open",
    title: "打开设置",
    group: "general",
    defaultKey: "mod+,",
  },
  {
    id: "theme.toggle",
    title: "切换外观主题",
    group: "general",
    defaultKey: "",
  },
  {
    id: "project.openFolder",
    title: "添加项目目录",
    group: "general",
    defaultKey: "",
  },
  {
    id: "session.new",
    title: "新建对话",
    group: "session",
    defaultKey: "mod+shift+o",
    defaultWhen: "!terminalFocus",
  },
  {
    id: "session.newStandalone",
    title: "新建独立对话",
    group: "session",
    defaultKey: "",
  },
  {
    id: "session.delete",
    title: "删除对话",
    group: "session",
    defaultKey: "mod+shift+delete",
    defaultWhen: "sessionActive && !inputFocus",
    secondaryDefaults: [{ key: "mod+shift+backspace", when: "sessionActive && !inputFocus" }],
  },
  {
    id: "chat.find",
    title: "在对话中查找",
    group: "session",
    defaultKey: "mod+f",
    defaultWhen: "sessionActive && !terminalFocus",
  },
  {
    id: "session.nextAttention",
    title: "下一个需要处理的对话",
    group: "session",
    defaultKey: "",
  },
  {
    id: "quickOpen.toggle",
    title: "跳转文件",
    group: "navigation",
    defaultKey: "mod+p",
    defaultWhen: "!terminalFocus",
  },
  {
    id: "files.search",
    title: "搜索文件",
    group: "navigation",
    defaultKey: "mod+shift+f",
    defaultWhen: "projectActive && !terminalFocus",
  },
  {
    id: "board.toggle",
    title: "打开看板",
    group: "navigation",
    defaultKey: "",
  },
  {
    id: "session.prev",
    title: "切换到上一个对话",
    group: "navigation",
    defaultKey: "mod+shift+[",
  },
  {
    id: "session.next",
    title: "切换到下一个对话",
    group: "navigation",
    defaultKey: "mod+shift+]",
  },
  ...JUMP_COMMANDS,
  {
    id: "terminal.toggle",
    title: "显示/隐藏终端",
    group: "panel",
    defaultKey: "mod+`",
  },
  {
    id: "sideChat.toggle",
    title: "显示/隐藏侧边聊天",
    group: "panel",
    defaultKey: "ctrl+alt+s",
  },
  {
    id: "panel.toggleFiles",
    title: "显示/隐藏“文件”面板",
    group: "panel",
    defaultKey: "",
  },
  {
    id: "panel.toggleChanges",
    title: "显示/隐藏“变更”面板",
    group: "panel",
    defaultKey: "mod+d",
    defaultWhen: "sessionActive && !terminalFocus",
  },
  {
    id: "browser.annotate",
    title: "切换网页批注",
    group: "panel",
    defaultKey: "mod+shift+.",
    defaultWhen: "panelOpen && !inputFocus",
  },
];

export const KEYBINDING_COMMAND_BY_ID: ReadonlyMap<string, KeybindingCommandMeta> = new Map(
  KEYBINDING_COMMANDS.map((meta) => [meta.id, meta]),
);

function buildDefaultRules(commands: readonly KeybindingCommandMeta[]): KeybindingRule[] {
  const rules: KeybindingRule[] = [];
  for (const meta of commands) {
    if (meta.defaultKey) {
      rules.push({
        command: meta.id,
        key: meta.defaultKey,
        ...(meta.defaultWhen ? { when: meta.defaultWhen } : {}),
      });
    }
    if (meta.secondaryDefaults) {
      for (const extra of meta.secondaryDefaults) {
        if (!extra.key) continue;
        rules.push({
          command: meta.id,
          key: extra.key,
          ...(extra.when ? { when: extra.when } : {}),
        });
      }
    }
  }
  return rules;
}

export const DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = buildDefaultRules(KEYBINDING_COMMANDS);

function sameChord(
  rule: ResolvedKeybindingRule,
  targetKey: string,
  platform: ShortcutPlatform,
): boolean {
  const ruleChord = normalizePhysicalChord(rule.parsed ?? rule.key, platform);
  const targetChord = normalizePhysicalChord(targetKey, platform);
  if (ruleChord && targetChord) return ruleChord === targetChord;
  return rule.key.trim().toLowerCase() === targetKey.trim().toLowerCase();
}

/**
 * 将 `keybindings.json` 中的用户规则叠加到默认规则上：
 * - `{ command: "-foo", key?: "..." }`、`{ command: "foo", key: "" }` 或 `when: "false"` 会移除匹配的默认/前置规则；
 * - 其余规则按顺序追加到末尾，派发时从后往前匹配（last matching rule wins）。
 */
export function resolveKeybindings(
  defaults: readonly KeybindingRule[] = DEFAULT_KEYBINDINGS,
  userRules: readonly KeybindingRule[] = [],
  platform: ShortcutPlatform = detectShortcutPlatform(),
): ResolvedKeybindingRule[] {
  let active: ResolvedKeybindingRule[] = defaults
    .filter((rule) => Boolean(rule.command?.trim() && rule.key?.trim() && rule.when?.trim() !== "false"))
    .map((rule, idx) => ({
      index: idx,
      command: rule.command.trim(),
      key: rule.key.trim(),
      ...(rule.when?.trim() ? { when: rule.when.trim() } : {}),
      source: "default" as const,
      parsed: parseShortcut(rule.key),
    }));

  for (const raw of userRules) {
    const rawCmd = raw.command?.trim() ?? "";
    if (!rawCmd) continue;
    const rawKey = raw.key?.trim() ?? "";
    const rawWhen = raw.when?.trim();

    if (rawCmd.startsWith("-")) {
      const targetCmd = rawCmd.slice(1).trim();
      if (!targetCmd) continue;
      active = active.filter((item) => {
        if (item.command !== targetCmd) return true;
        if (rawKey && !sameChord(item, rawKey, platform)) return true;
        if (rawWhen !== undefined && (item.when ?? "") !== rawWhen) return true;
        return false;
      });
      continue;
    }

    if (!rawKey) {
      active = active.filter((item) => item.command !== rawCmd);
      continue;
    }

    if (rawWhen === "false") {
      active = active.filter((item) => !(item.command === rawCmd && sameChord(item, rawKey, platform)));
      continue;
    }

    active.push({
      index: 0,
      command: rawCmd,
      key: rawKey,
      ...(rawWhen ? { when: rawWhen } : {}),
      source: "user",
      parsed: parseShortcut(rawKey),
    });
  }

  return active.map((item, idx) => ({ ...item, index: idx }));
}

export const DEFAULT_RESOLVED_KEYBINDINGS: readonly ResolvedKeybindingRule[] = resolveKeybindings(
  DEFAULT_KEYBINDINGS,
  [],
);

/** 按从后往前的顺序找到当前事件与上下文下命中的最高优先级规则。 */
export function matchKeybinding(
  event: ShortcutKeyboardEvent,
  context: Partial<WhenContext>,
  rules: readonly ResolvedKeybindingRule[] = DEFAULT_RESOLVED_KEYBINDINGS,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): ResolvedKeybindingRule | null {
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const rule = rules[i];
    if (!rule.parsed) continue;
    if (rule.when?.trim() === "false") continue;
    if (!matchesShortcut(event, rule.parsed, platform)) continue;
    if (!evaluateWhen(rule.when, context)) continue;
    return rule;
  }
  return null;
}

/** 判断本次键盘事件在全局优先级裁决后是否命中指定命令。 */
export function matchesCommandBinding(
  commandId: string,
  event: ShortcutKeyboardEvent,
  context: Partial<WhenContext>,
  rules: readonly ResolvedKeybindingRule[] = DEFAULT_RESOLVED_KEYBINDINGS,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): boolean {
  const winner = matchKeybinding(event, context, rules, platform);
  return winner?.command === commandId;
}

/** 取某条命令在界面上展示的主快捷键文案（用户自定义优先，解绑后返回 `undefined`）。 */
export function formatCommandShortcut(
  commandId: string,
  rules: readonly ResolvedKeybindingRule[] = DEFAULT_RESOLVED_KEYBINDINGS,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string | undefined {
  const matching = rules.filter((rule) => rule.command === commandId && rule.parsed);
  if (matching.length === 0) return undefined;
  const userRules = matching.filter((rule) => rule.source === "user");
  const chosen = userRules.length > 0 ? userRules[userRules.length - 1] : matching[0];
  const label = formatShortcutLabel(chosen.parsed ?? chosen.key, platform);
  return label || undefined;
}
