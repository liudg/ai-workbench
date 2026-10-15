import { modelButtonLabel } from "../../../lib/catalog.ts";
import { filterSlash, slashToken } from "../../../lib/slash.ts";
import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import { extrasAllowed } from "./access.ts";
import { effortDisplay } from "./effort-label.ts";
import {
  baselineServiceTier,
  effectiveServiceTier,
  fastTier,
  fastTierTip,
  modelChipText,
  supportsFast,
} from "./model-picker.ts";
import { pickEffort, pickModel } from "./model-selection.ts";
import { isReadOnlyOpen, pendingPrompt } from "../../../lib/utils.ts";
import {
  type AgentCapabilities,
  type AgentCatalog,
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
import { type GoalSnapshot } from "./goal.ts";
import { goalStatusModel } from "./goal-status.ts";
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
  /** 已选文本片。空输入也能发送。 */
  snippetCount: number;
  goalDraft: boolean;
  /** 服务端还有未清除的目标，而且用户没有刚关掉芯片。 */
  goalLive?: boolean;
  goal?: GoalSnapshot | null;
  /** 草稿正在创建会话。队列型 Agent 这时也不能再发一条。 */
  inputLocked?: boolean;
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
  const held = Boolean(input.inputLocked);
  const caps = input.caps;
  const imagesOn = Boolean(caps?.supports_images);
  const queueOn = Boolean(caps?.supports_queue);
  const composerLocked = held || (queueOn ? dead || occupied : busy || dead || occupied);
  const menusLocked = held || busy || dead || occupied;
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
  const hasText = Boolean(input.text.trim());
  const hasSnippets = input.snippetCount > 0;
  const stopMode =
    held ||
    (queueOn && busy && !input.editingId && !pendingId && !hasText && !hasSnippets && input.fileCount === 0);
  const sendDisabled = stopMode
    ? false
    : composerLocked ||
      !(pendingId
        ? hasText
        : imagesOn
          ? hasText || hasSnippets || input.fileCount > 0
          : hasText || hasSnippets);
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
    goalStatus: goalOn ? goalStatusModel(input.goal ?? null, !input.goal?.objective) : null,
    stopMode,
    sendDisabled,
    showPlan: Boolean(caps?.supports_plan),
    showModel: Boolean(caps?.supports_tuning),
    permissionMenu: menu,
    showNetwork: Boolean(menu?.network_access) && extrasAllowed(menu, input.sandbox),
    showWritable: Boolean(menu?.writable_roots) && extrasAllowed(menu, input.sandbox),
  };
}
