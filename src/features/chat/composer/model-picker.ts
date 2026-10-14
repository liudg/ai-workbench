import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import {
  effortLabel,
  type AgentCatalog,
  type AgentModelOption,
  type ReasoningEffortOption,
  type SessionTuning,
} from "../../../types/index.ts";
import { effortForModel } from "./composer-submit.ts";

/**
 * Codex TUI 把 Max / Ultra 从普通推理档里拆出去，避免在正常刻度上误选。
 * 见 `codex-rs/tui/src/chatwidget/model_popups.rs` 的 `is_advanced_reasoning_effort`。
 */
const ADVANCED_EFFORTS = new Set(["max", "ultra"]);

/** 与 Codex `ServiceTier::Fast` / `SPEED_TIER_FAST` 相同的 id。 */
export const FAST_TIER_ID = "fast";

/** 请求里的这个值表示不覆盖，TUI 不会把它写进 turn。 */
const SERVICE_TIER_DEFAULT = "default";

export function isAdvancedEffort(id: string | undefined): boolean {
  return ADVANCED_EFFORTS.has(id?.trim() ?? "");
}

/**
 * 滑杆刻度是该模型 `supportedReasoningEfforts` 里的普通档，顺序跟目录一致。
 * 只有 Max / Ultra 时才把它们放上滑杆，否则强度没有可选项。
 */
export function sliderEfforts(model: AgentModelOption | undefined): ReasoningEffortOption[] {
  if (!model) return [];
  const standard = model.efforts.filter((effort) => !isAdvancedEffort(effort.id));
  if (standard.length > 0) return standard;
  if (model.efforts.length > 0) return model.efforts;
  const fallback = model.default_effort.trim();
  if (!fallback) return [];
  return [{ id: fallback, description: "" }];
}

/** 指针位置吸附到最近的刻度。 */
export function snapEffortIndex(clientX: number, left: number, width: number, count: number): number {
  if (count <= 1 || width <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, (clientX - left) / width));
  return Math.round(ratio * (count - 1));
}

/** 芯片是「模型名 强度」，中间没有间隔号。 */
export function modelChipText(label: string, effort: string | undefined): string {
  if (!effort?.trim()) return label;
  return `${label} ${effortLabel(effort)}`;
}

export interface ModelSection {
  id: "default" | "recommended";
  title: string;
  models: AgentModelOption[];
}

/** 目录里标了 isDefault 的进「默认」，其余可见模型进「推荐模型集」。 */
export function modelSections(models: readonly AgentModelOption[]): ModelSection[] {
  const visible = models.filter((model) => model.show_in_picker !== false);
  const defaults = visible.filter((model) => model.is_default);
  const recommended = visible.filter((model) => !model.is_default);
  const sections: ModelSection[] = [];
  if (defaults.length > 0) {
    sections.push({ id: "default", title: DESKTOP_ZH.modelSectionDefault, models: defaults });
  }
  if (recommended.length > 0) {
    sections.push({
      id: "recommended",
      title: DESKTOP_ZH.modelSectionRecommended,
      models: recommended,
    });
  }
  return sections;
}

export function fastTier(model: AgentModelOption | undefined) {
  return model?.service_tiers?.find((tier) => tier.id === FAST_TIER_ID);
}

/** 有 Fast 档才显示闪电。Claude 这类没有 service tier 的目录不会出现这个开关。 */
export function supportsFast(model: AgentModelOption | undefined): boolean {
  return Boolean(fastTier(model));
}

function usableTier(id: string | null | undefined, model: AgentModelOption | undefined): string | null {
  const trimmed = id?.trim() ?? "";
  if (!trimmed || trimmed === SERVICE_TIER_DEFAULT) return null;
  if (!model?.service_tiers?.some((tier) => tier.id === trimmed)) return null;
  return trimmed;
}

/** 配置里的 service_tier，否则模型自己的 default。两者都没有就是关。 */
export function baselineServiceTier(
  model: AgentModelOption | undefined,
  catalog: AgentCatalog | undefined,
): string | null {
  return usableTier(catalog?.configured_service_tier, model) ?? usableTier(model?.default_service_tier, model);
}

export function effectiveServiceTier(
  model: AgentModelOption | undefined,
  tuning: SessionTuning | undefined,
  catalog: AgentCatalog | undefined,
): string | null {
  if (!model) return null;
  if (tuning?.model === model.id && tuning.serviceTier !== undefined) {
    return usableTier(tuning.serviceTier, model);
  }
  return baselineServiceTier(model, catalog);
}

export function tuningForModel(
  model: AgentModelOption,
  effort: string | undefined,
  storedTier: string | null | undefined,
): SessionTuning {
  const next: SessionTuning = { model: model.id, effort: effortForModel(model, effort) };
  if (storedTier !== undefined) next.serviceTier = usableTier(storedTier, model);
  return next;
}
