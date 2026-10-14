import type { AgentCatalog, AgentModelOption, SessionTuning } from "../../../types/index.ts";

function stripModelBrackets(raw: string): string {
  const trimmed = raw.trim();
  const open = trimmed.lastIndexOf("[");
  if (open > 0 && trimmed.endsWith("]")) return trimmed.slice(0, open).trim();
  return trimmed;
}

/**
 * 报告名对上目录里的哪一行。
 * 顺序跟 Claude 目录对齐一致：精确 id → resolvedModel → label，括号后缀只在精确没命中时再剥。
 */
export function modelInCatalog(
  catalog: AgentCatalog | undefined,
  id: string | null | undefined,
): AgentModelOption | undefined {
  const trimmed = id?.trim();
  if (!trimmed) return undefined;
  const models = catalog?.models;
  if (!models?.length) return undefined;
  const byId = models.find((item) => item.id === trimmed);
  if (byId) return byId;
  const byResolved = models.find((item) => item.resolved_model && item.resolved_model === trimmed);
  if (byResolved) return byResolved;
  const byLabel = models.find((item) => item.label === trimmed);
  if (byLabel) return byLabel;
  const stripped = stripModelBrackets(trimmed);
  if (stripped !== trimmed) {
    return (
      models.find((item) => item.resolved_model === stripped) ??
      models.find((item) => item.label === stripped) ??
      models.find((item) => item.id === stripped)
    );
  }
  return undefined;
}

/**
 * 用户没选过模型时，显示顺序是：已打开线程的模型、CLI `config/read` 的 model、
 * 目录里标了 isDefault 的模型（仅当配置里没写 model）。不拿列表第一项充数。
 */
export function pickModel(catalog: AgentCatalog | undefined, tuning: SessionTuning | undefined) {
  const tuned = modelInCatalog(catalog, tuning?.model);
  if (tuned) return tuned;
  const thread = modelInCatalog(catalog, catalog?.thread_model);
  if (thread) return thread;
  const configured = modelInCatalog(catalog, catalog?.configured_model);
  if (configured) return configured;
  if (catalog?.cli_config_read === false) return undefined;
  return catalog?.models.find((item) => item.is_default);
}

function effortAllowed(model: AgentModelOption | undefined, effort: string | null | undefined) {
  const id = effort?.trim();
  if (!id) return undefined;
  if (!model || model.efforts.length === 0 || model.efforts.some((item) => item.id === id)) return id;
  return undefined;
}

/** 强度跟 CLI：配置里的 `model_reasoning_effort`，否则该模型自己的 defaultReasoningEffort。 */
export function pickEffort(
  tuning: SessionTuning | undefined,
  model: AgentModelOption | undefined,
  catalog?: AgentCatalog,
) {
  const chosen = effortAllowed(model, tuning?.effort);
  if (tuning?.model && chosen) return chosen;
  if (!tuning?.model) {
    const thread = catalog?.thread_effort?.trim();
    if (catalog?.thread_model && thread) return thread;
    const configured = catalog?.configured_effort?.trim();
    if (!catalog?.thread_model && configured) return configured;
  }
  return model?.default_effort || undefined;
}
