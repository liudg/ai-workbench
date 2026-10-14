import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import type { AgentModelOption } from "../../../types/index.ts";
import { shortHanLabel } from "./choice-text.ts";

/**
 * 目录档位 id → 中文短标签。
 * 滑杆上有哪些档只看当前模型的 `efforts`，这里不增加、不删减。
 * 不翻译 `description` / 英文 displayName。
 */
const CHROME: Record<string, string> = {
  none: DESKTOP_ZH.effortNone,
  minimal: DESKTOP_ZH.effortMinimal,
  min: DESKTOP_ZH.effortMinimal,
  low: DESKTOP_ZH.effortLow,
  medium: DESKTOP_ZH.effortMedium,
  med: DESKTOP_ZH.effortMedium,
  high: DESKTOP_ZH.effortHigh,
  xhigh: DESKTOP_ZH.effortVeryHigh,
  "x-high": DESKTOP_ZH.effortVeryHigh,
  "extra-high": DESKTOP_ZH.effortVeryHigh,
  extrahigh: DESKTOP_ZH.effortVeryHigh,
  "very-high": DESKTOP_ZH.effortVeryHigh,
  veryhigh: DESKTOP_ZH.effortVeryHigh,
  max: DESKTOP_ZH.effortMax,
  maximum: DESKTOP_ZH.effortMax,
  ultra: DESKTOP_ZH.effortUltra,
};

function effortKey(id: string): string {
  return id.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/** 已知 id 的短标签。不认识返回空字符串。 */
export function effortChromeLabel(id: string): string {
  const key = effortKey(id);
  if (!key) return "";
  return CHROME[key] ?? CHROME[key.replace(/-/g, "")] ?? "";
}

export function effortChoiceLabel(
  option: { id: string; label?: string | null } | undefined,
): string {
  if (!option) return "";
  return effortChromeLabel(option.id) || shortHanLabel(option.label) || option.id.trim();
}

/** 当前模型目录里这个档位的短标签。档不在目录里就不显示。 */
export function effortDisplay(model: AgentModelOption | undefined, effortId: string | undefined): string {
  const id = effortId?.trim();
  if (!id) return "";
  const option = model?.efforts.find((item) => item.id === id);
  return option ? effortChoiceLabel(option) : "";
}
