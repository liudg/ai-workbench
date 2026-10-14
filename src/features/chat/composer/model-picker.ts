import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import {
  type AgentCatalog,
  type AgentModelOption,
  type ReasoningEffortOption,
  type SessionTuning,
} from "../../../types/index.ts";
import { effortForModel } from "./composer-submit.ts";

/** 与 Codex `ServiceTier::Fast` / `SPEED_TIER_FAST` 相同的 id。 */
export const FAST_TIER_ID = "fast";

/** 请求里的这个值表示不覆盖，TUI 不会把它写进 turn。 */
const SERVICE_TIER_DEFAULT = "default";

/** 档位文案来自目录：短名，否则 description，否则 id。 */
export function effortText(option: Pick<ReasoningEffortOption, "id" | "description"> & { label?: string | null } | undefined): string {
  if (!option) return "";
  return option.label?.trim() || option.description.trim() || option.id;
}

export function effortDisplay(model: AgentModelOption | undefined, effortId: string | undefined): string {
  const id = effortId?.trim();
  if (!id) return "";
  const option = model?.efforts.find((item) => item.id === id);
  return option ? effortText(option) : id;
}

/** 滑杆刻度就是该模型目录里的档位，顺序和数量都不改。 */
export function sliderEfforts(model: AgentModelOption | undefined): ReasoningEffortOption[] {
  return model?.efforts ?? [];
}

/** 指针位置吸附到最近的刻度。 */
export function snapEffortIndex(clientX: number, left: number, width: number, count: number): number {
  if (count <= 1 || width <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, (clientX - left) / width));
  return Math.round(ratio * (count - 1));
}

/** 芯片是「模型名 强度」。强度已经是目录文案，这里不再翻译。 */
export function modelChipText(label: string, effort: string | undefined): string {
  const text = effort?.trim();
  if (!text) return label;
  return `${label} ${text}`;
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
