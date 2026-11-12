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
import { timelineStatus } from "../timeline/timeline.ts";
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
  /** 停止或失败后还能接着发：下一条会重新接上 Agent。 */
  resumable?: boolean;
}

/** 会话目录优先。静态 profile 只在目录还没回来时顶上，而且必须是这一个 Agent 的。 */
export function composerCaps(
  catalog: AgentCatalog | undefined,
  profile: AgentProfile | undefined,
): AgentCapabilities | undefined {
  return catalog?.capabilities ?? profile?.capabilities;
}

/** 目录一到，斜杠命令只认这份目录，哪怕它是空的。`/plan`、`/goal` 和 `@` 菜单里的「计划」「目标」是同一个入口，
 *  Agent 支持就由作曲栏自己处理并列出，说明也和 `@` 菜单一致。 */
export function composerCommands(
  catalog: AgentCatalog | undefined,
  profile: AgentProfile | undefined,
): SlashCommand[] {
  let listed = catalog ? [...catalog.commands] : profile?.commands ? [...profile.commands] : [];
  const caps = composerCaps(catalog, profile);
  const own: SlashCommand[] = [];
  if (caps?.supports_plan) own.push({ name: "/plan", hint: DESKTOP_ZH.planOn, takes_args: true });
  if (caps?.supports_goals) own.push({ name: "/goal", hint: DESKTOP_ZH.goalHint, takes_args: true });
  for (const command of own) {
    const index = listed.findIndex((item) => item.name === command.name);
    listed = index < 0 ? [command, ...listed] : listed.map((item, at) => (at === index ? command : item));
  }
  return listed;
}

function pendingKindOf(events: readonly SessionEvent[], pendingId: string | null): string | null {
  if (!pendingId) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "prompt" && event.prompt_id === pendingId) return event.prompt_kind;
  }
  return null;
}

export function deriveComposerView(input: ComposerViewInput) {
  const pendingId = pendingPrompt([...input.events]);
  const pendingKind = pendingKindOf(input.events, pendingId);
  const occupied = isReadOnlyOpen([...input.events]);
  const starting = input.status === "starting";
  const busy = starting || input.status === "running";
  const dead = !input.resumable && (input.status === "stopped" || input.status === "failed");
  const held = starting || Boolean(input.inputLocked);
  const caps = input.caps;
  const imagesOn = Boolean(caps?.supports_images);
  const queueOn = Boolean(caps?.supports_queue);
  const cancelOn = starting || Boolean(caps?.supports_cancel);
  const composerLocked = held || (queueOn ? dead || occupied : busy || dead || occupied);
  const menusLocked = held || busy || dead || occupied;
  const token = caps?.supports_slash && !pendingId && !menusLocked ? slashToken(input.text) : null;
  const slashMatches = token ? filterSlash([...input.commands], token) : [];
  // 敲完命令名、开始写参数后菜单收起，回车就是发送。
  const slashOpen = token !== null && !/\s/.test(input.text) && (slashMatches.length > 0 || token.length > 1);
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
  const showPlan = Boolean(caps?.supports_plan);
  const goalOn = mode === "goal";
  const placeholder = occupied
    ? "此会话已在其他窗口打开，仅可查看"
    : dead
      ? "会话已停止，请新建会话"
      : queueOn && busy
        ? "添加后续消息"
        : input.goalDraft
          ? DESKTOP_ZH.goalPlaceholder
          : planOn
            ? DESKTOP_ZH.planPlaceholder
            : "输入任务或问题，@ 引用文件";
  const hasText = Boolean(input.text.trim());
  const hasSnippets = input.snippetCount > 0;
  // 会话列表可能晚一拍。回合是否还在，以事件日志最后一次状态为准，和对话时间线一致。
  // 停止只看 supports_cancel 和回合是否还开着。排队另看 supports_queue。
  // 正在跑，或停在审批 / 提问（needs-input），空输入都保持停止。待发草稿仍是发送。
  const live = timelineStatus(input.events, input.status);
  const turnOpen = live === "starting" || live === "running" || live === "needs-input";
  const stopMode =
    held ||
    (cancelOn && turnOpen && !input.editingId && !hasText && !hasSnippets && input.fileCount === 0);
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
    pendingKind,
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
    /**
     * 作曲栏页脚的计划标识。跟协作模式走：模式是 plan 就在，
     * 用户消息不会把它清掉。点一下、或协作模式回到 default，才消失。
     */
    planIndicator: showPlan && planOn,
    /** 输入框里的目标 pill。只在目标还没提交时出现，跟已保存的目标条分开。 */
    goalChip: Boolean(input.goalDraft),
    goalStatus: goalOn ? goalStatusModel(input.goal ?? null, !input.goal?.objective) : null,
    stopMode,
    sendDisabled,
    showPlan,
    showModel: Boolean(caps?.supports_tuning),
    permissionMenu: menu,
    showNetwork: Boolean(menu?.network_access) && extrasAllowed(menu, input.sandbox),
    showWritable: Boolean(menu?.writable_roots) && extrasAllowed(menu, input.sandbox),
  };
}

/** 主按钮。停止态中断当前回合，否则提交输入。 */
export function runComposerPrimary(
  stopMode: boolean,
  actions: { interrupt: () => void; submit: () => void },
): void {
  if (stopMode) actions.interrupt();
  else actions.submit();
}
