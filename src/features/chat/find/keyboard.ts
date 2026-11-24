import { buildWhenContext } from "../../../shared/keybindings/context.ts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  matchesCommandBinding,
} from "../../../shared/keybindings/defaults.ts";
import type { ShortcutKeyboardEvent } from "../../../shared/keybindings/shortcut.ts";
import type { ResolvedKeybindingRule, ShortcutPlatform } from "../../../shared/keybindings/types.ts";

/**
 * 默认用 Mod+F 打开当前会话的查找，并支持用户在快捷键设置中自定义 `chat.find`。
 */
export function matchesThreadFindBinding(
  event: ShortcutKeyboardEvent & { target?: EventTarget | null },
  rules: readonly ResolvedKeybindingRule[] = DEFAULT_RESOLVED_KEYBINDINGS,
  platform?: ShortcutPlatform,
  projectActive?: boolean,
): boolean {
  const context = buildWhenContext({
    sessionActive: true,
    projectActive,
    target: event.target ?? null,
  });
  return matchesCommandBinding("chat.find", event, context, rules, platform);
}
