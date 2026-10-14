import { modelButtonLabel } from "../../../lib/catalog.ts";
import { filterSlash, slashToken } from "../../../lib/slash.ts";
import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import { extrasAllowed } from "./access.ts";
import {
  baselineServiceTier,
  effectiveServiceTier,
  effortDisplay,
  fastTier,
  fastTierTip,
  modelChipText,
  supportsFast,
} from "./model-picker.ts";
import { isReadOnlyOpen, pendingPrompt } from "../../../lib/utils.ts";
import {
  type AgentCapabilities,
  type AgentCatalog,
  type AgentModelOption,
  type AgentProfile,
  type AgentSkillOption,
  type SessionTuning,
  type PermissionMenu,
  type Session,
  type SessionEvent,
  type SessionSandbox,
  type SlashCommand,
} from "../../../types/index.ts";
import { exclusiveComposerMode } from "./collaboration-mode.ts";
import { contextUsageLine } from "./context-usage.ts";
import { type GoalSnapshot } from "./goal.ts";
import { goalStatusLine } from "./goal-status.ts";
import { atToken, mentionSupport, type MentionSupport } from "./mentions.ts";
import { filterSkills, skillToken } from "./skills.ts";

export interface ComposerViewInput {
  status: Session["status"];
  events: readonly SessionEvent[];
  caps: AgentCapabilities | undefined;
  permissionMenu: PermissionMenu | null;
  sandbox: SessionSandbox | null;
  commands: readonly SlashCommand[];
  skills: readonly AgentSkillOption[];
  catalog: AgentCatalog | undefined;
  tuning: SessionTuning | undefined;
  catalogNotice: string | null;
  text: string;
  caret: number;
  editingId: string | null;
  fileCount: number;
  goalDraft: boolean;
  /** 服务端还有未清除的目标，而且用户没有刚关掉芯片。 */
  goalLive?: boolean;
  goal?: GoalSnapshot | null;
}

function stripModelBrackets(raw: string): string {
  const trimmed = raw.trim();
  const open = trimmed.lastIndexOf("[");
  if (open > 0 && trimmed.endsWith("]")) return trimmed.slice(0, open).trim();
  return trimmed;
}

function modelInCatalog(catalog: AgentCatalog | undefined, id: string | null | undefined): AgentModelOption | undefined {
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

/** 会话目录优先。静态 profile 只在目录还没回来时顶上，而且必须是这一个 Agent 的。 */
export function composerCaps(
  catalog: AgentCatalog | undefined,
  profile: AgentProfile | undefined,
): AgentCapabilities | undefined {
  return catalog?.capabilities ?? profile?.capabilities;
}

/** 目录一到，斜杠命令只认这份目录，哪怕它是空的。 */
export function composerCommands(
  catalog: AgentCatalog | undefined,
  profile: AgentProfile | undefined,
): SlashCommand[] {
  if (catalog) return [...catalog.commands];
  return profile?.commands ? [...profile.commands] : [];
}

export function deriveComposerView(input: ComposerViewInput) {
  const pendingId = pendingPrompt([...input.events]);
  const occupied = isReadOnlyOpen([...input.events]);
  const busy = input.status === "running";
  const dead = input.status === "stopped" || input.status === "failed";
  const caps = input.caps;
  const imagesOn = Boolean(caps?.supports_images);
  const queueOn = Boolean(caps?.supports_queue);
  const composerLocked = queueOn ? dead || occupied : busy || dead || occupied;
  const menusLocked = busy || dead || occupied;
  const token = caps?.supports_slash && !pendingId && !menusLocked ? slashToken(input.text) : null;
  const slashMatches = token ? filterSlash([...input.commands], token) : [];
  const slashOpen = token !== null && (slashMatches.length > 0 || token.length > 1);
  const mentionQuery =
    !pendingId && !menusLocked && !slashOpen ? atToken(input.text, input.caret) : null;
  const mentionOpen = mentionQuery !== null;
  const skillQuery =
    caps?.supports_skills && !pendingId && !menusLocked && !slashOpen && !mentionOpen
      ? skillToken(input.text, input.caret)
      : null;
  const skillMatches = skillQuery !== null ? filterSkills([...input.skills], skillQuery) : [];
  const skillOpen = skillQuery !== null;
  const capsKnown = input.caps !== undefined;
  const goalSupport: MentionSupport = mentionSupport(capsKnown, Boolean(caps?.supports_goals));
  const planSupport: MentionSupport = mentionSupport(capsKnown, Boolean(caps?.supports_plan));
  const selectedModel = pickModel(input.catalog, input.tuning);
  const selectedEffort = pickEffort(input.tuning, selectedModel, input.catalog);
  const baselineModel = pickModel(input.catalog, undefined);
  const baselineEffort = pickEffort(undefined, baselineModel, input.catalog);
  const storedServiceTier = input.tuning?.serviceTier;
  const selectedServiceTier = effectiveServiceTier(selectedModel, input.tuning, input.catalog);
  const fast = fastTier(selectedModel);
  const unreadConfig = input.catalog?.cli_config_read === false && !selectedModel;
  const effortLabel = selectedModel ? effortDisplay(selectedModel, selectedEffort) : "";
  const modelName = selectedModel?.label || undefined;
  const modelButton = modelButtonLabel(
    selectedModel
      ? modelChipText(selectedModel.label, effortLabel)
      : unreadConfig
        ? DESKTOP_ZH.modelConfigUnread
        : input.catalog && input.catalog.models.length > 0
          ? DESKTOP_ZH.selectEffort
          : undefined,
    input.catalog,
    input.catalogNotice,
  );
  const mode = exclusiveComposerMode(input.events, {
    draft: input.goalDraft,
    live: Boolean(input.goalLive),
  });
  const planOn = mode === "plan";
  const goalOn = mode === "goal";
  const placeholder = occupied
    ? "此会话正被其他进程占用，只能查看"
    : dead
      ? "会话已停止，请新建会话"
      : queueOn && busy
        ? "添加后续消息"
        : input.goalDraft
          ? DESKTOP_ZH.goalPlaceholder
          : planOn
            ? DESKTOP_ZH.planPlaceholder
            : "随心输入";
  const stopMode =
    queueOn && busy && !input.editingId && !pendingId && !input.text.trim() && input.fileCount === 0;
  const sendDisabled = stopMode
    ? false
    : composerLocked ||
      !(pendingId
        ? input.text.trim()
        : imagesOn
          ? input.text.trim() || input.fileCount > 0
          : input.text.trim());
  const menu = input.permissionMenu;
  return {
    pendingId,
    occupied,
    busy,
    dead,
    imagesOn,
    queueOn,
    composerLocked,
    menusLocked,
    token,
    slashMatches,
    slashOpen,
    skillQuery,
    skillMatches,
    skillOpen,
    mentionQuery,
    mentionOpen,
    mentionAdd: mentionQuery === "",
    goalSupport,
    planSupport,
    selectedModel,
    selectedEffort,
    modelName,
    effortLabel: effortLabel || undefined,
    modelButton,
    fastOn: Boolean(fast && selectedServiceTier === fast.id),
    fastAvailable: supportsFast(selectedModel),
    fastTip: fastTierTip(selectedModel),
    storedServiceTier,
    baselineModelId: baselineModel?.id,
    baselineEffort,
    baselineServiceTier: baselineServiceTier(baselineModel, input.catalog),
    placeholder,
    planOn,
    goalOn,
    goalStatus: goalOn ? goalStatusLine(input.goal ?? null, !input.goal?.objective) : null,
    contextUsage: contextUsageLine(input.events),
    stopMode,
    sendDisabled,
    showPlan: Boolean(caps?.supports_plan),
    showModel: Boolean(caps?.supports_tuning),
    permissionMenu: menu,
    showNetwork: Boolean(menu?.network_access) && extrasAllowed(menu, input.sandbox),
    showWritable: Boolean(menu?.writable_roots) && extrasAllowed(menu, input.sandbox),
  };
}
