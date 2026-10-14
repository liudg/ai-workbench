import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import type { PermissionProfileOption } from "../../../types/index.ts";

/**
 * 内置档位 id → 中文标题。
 * 和 Claude 权限菜单同一套说法；适配器已经给了中文（例如「跳过权限检查」）就保持。
 * 具名配置档不在这张表里，标题仍是菜单里的 label。
 */
const PRESET_CHROME: Record<string, string> = {
  ask: DESKTOP_ZH.permissionAsk,
  "approve-for-me": DESKTOP_ZH.permissionApprove,
  full: DESKTOP_ZH.permissionFull,
  "read-only": DESKTOP_ZH.permissionReadOnly,
};

function hasHan(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

export function permissionChoiceLabel(item: Pick<PermissionProfileOption, "id" | "label">): string {
  const label = item.label.trim();
  const chrome = PRESET_CHROME[item.id];
  if (chrome && (!label || !hasHan(label))) return chrome;
  return label || chrome || item.id;
}

/** 英文 TUI 标题「Update Model Permissions」显示成「权限」。适配器已给的中文标题保持。 */
export function permissionMenuTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || trimmed.toLowerCase() === "update model permissions") return DESKTOP_ZH.permissionMenu;
  return trimmed;
}

/** 选项下只保留不可选的原因。能力说明 `description` 不进菜单。 */
export function permissionRowDetail(
  item: Pick<PermissionProfileOption, "description" | "disabled_reason">,
): string | null {
  const reason = item.disabled_reason?.trim();
  return reason || null;
}
