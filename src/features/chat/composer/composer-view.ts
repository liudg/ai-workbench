import { modelButtonLabel } from "../../../lib/catalog.ts";
import { filterSlash, slashToken } from "../../../lib/slash.ts";
import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import { isReadOnlyOpen, pendingPrompt } from "../../../lib/utils.ts";
import {
  effortLabel,
  type AgentCapabilities,
  type AgentCatalog,
  type AgentModelOption,
  type AgentSkillOption,
  type PermissionMenu,
  type Session,
  type SessionEvent,
  type SessionSandbox,
  type SlashCommand,
} from "../../../types/index.ts";
import { sandboxAllowsExtras } from "./access.ts";
import { collaborationMode } from "./collaboration-mode.ts";
import { atToken, mentionSupport, type MentionSupport } from "./mentions.ts";
import { filterSkills, skillToken } from "./skills.ts";

export interface ComposerViewInput {
  status: Session["status"];
  events: readonly SessionEvent[];
  caps: AgentCapabilities | undefined;
  permissionMenu: PermissionMenu | null;
  sandbox: SessionSandbox;
  commands: readonly SlashCommand[];
  skills: readonly AgentSkillOption[];
  catalog: AgentCatalog | undefined;
  tuning: { model: string; effort: string } | undefined;
  catalogNotice: string | null;
  text: string;
  caret: number;
  editingId: string | null;
  fileCount: number;
  goalDraft: boolean;
}

export function pickModel(catalog: AgentCatalog | undefined, tuning: { model: string; effort: string } | undefined) {
  return (
    catalog?.models.find((item) => item.id === tuning?.model) ??
    catalog?.models.find((item) => item.is_default) ??
    catalog?.models[0]
  );
}

export function pickEffort(
  tuning: { model: string; effort: string } | undefined,
  model: AgentModelOption | undefined,
) {
  return tuning?.effort && model?.efforts.some((item) => item.id === tuning.effort)
    ? tuning.effort
    : model?.default_effort;
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
  const selectedEffort = pickEffort(input.tuning, selectedModel);
  const modelButton = modelButtonLabel(
    selectedModel ? `${selectedModel.label} · ${effortLabel(selectedEffort)}` : undefined,
    input.catalog,
    input.catalogNotice,
  );
  const planOn = collaborationMode(input.events) === "plan";
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
    modelButton,
    placeholder,
    planOn,
    stopMode,
    sendDisabled,
    showPlan: Boolean(caps?.supports_plan),
    showModel: Boolean(caps?.supports_tuning),
    permissionMenu: menu,
    showNetwork:
      Boolean(caps?.supports_network_access) &&
      (menu ? menu.network_access : true) &&
      sandboxAllowsExtras(input.sandbox),
    showWritable:
      Boolean(caps?.supports_writable_roots) &&
      (menu ? menu.writable_roots : true) &&
      sandboxAllowsExtras(input.sandbox),
  };
}
