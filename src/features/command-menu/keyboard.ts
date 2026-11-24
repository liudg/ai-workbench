/** 全局快捷键判定与命令菜单列表导航。全局快捷键统一委托给 `src/shared/keybindings` 解析。 */

import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  matchKeybinding,
} from "../../shared/keybindings/defaults.ts";
import type { ShortcutKeyboardEvent } from "../../shared/keybindings/shortcut.ts";
import type {
  ResolvedKeybindingRule,
  ShortcutPlatform,
  WhenContext,
} from "../../shared/keybindings/types.ts";

/** 根据生效的快捷键规则与当前上下文，解析出最高优先级的命中命令。 */
export function resolveGlobalCommand(
  event: ShortcutKeyboardEvent,
  context: Partial<WhenContext> = {},
  rules: readonly ResolvedKeybindingRule[] = DEFAULT_RESOLVED_KEYBINDINGS,
  platform?: ShortcutPlatform,
): ResolvedKeybindingRule | null {
  return matchKeybinding(event, context, rules, platform);
}

/** 提取 `session.jump.1..9` 命令里的 1..9 序号；非跳转命令返回 `null`。 */
export function parseSessionJumpIndex(commandId: string): number | null {
  const match = /^session\.jump\.([1-9])$/.exec(commandId);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

/** 删除和弦必须把面板打开到删除页。只改 drill 时菜单还关着，快捷键看起来没反应。 */
export function deleteShortcutMenu(_open: boolean): { open: true; drill: "delete" } {
  return { open: true, drill: "delete" };
}

export function moveCursor(index: number, count: number, key: "ArrowDown" | "ArrowUp"): number {
  if (count <= 0) return 0;
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  return Math.max(0, index - 1);
}

export function sectionStarts(groups: readonly string[]): number[] {
  const starts: number[] = [];
  let previous = "";
  groups.forEach((group, index) => {
    if (group !== previous) {
      starts.push(index);
      previous = group;
    }
  });
  return starts;
}

export function jumpSection(starts: readonly number[], current: number, direction: 1 | -1): number {
  if (starts.length === 0) return 0;
  let section = 0;
  for (let index = 0; index < starts.length; index += 1) {
    if (starts[index] <= current) section = index;
  }
  const next = (section + direction + starts.length) % starts.length;
  return starts[next] ?? 0;
}
