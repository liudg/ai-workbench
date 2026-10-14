import { useMemo, useRef, useState } from "react";

import {
  emptySandbox,
  type AgentCatalog,
  type AgentSkillOption,
  type PermissionMenu,
  type SessionEvent,
  type SessionTuning,
} from "@/types";
import { AccessMenu } from "./AccessMenu";
import { ComposerBar } from "./ComposerBar";
import { ComposerInput } from "./ComposerInput";
import { MentionMenu } from "./MentionMenu";
import { ModelMenu } from "./ModelMenu";
import { SkillMenu } from "./SkillMenu";
import { deriveComposerView } from "./composer-view";
import { effortForModel } from "./composer-submit";
import { fastTier, tuningForModel } from "./model-picker";
import { useComposerMenu } from "./useComposerMenu";
import { activeGoal } from "./goal";
import { atToken, clearAtToken, insertMention, mentionFiles } from "./mentions";

const workspaceFiles = Object.keys(
  import.meta.glob(["/src/**/*.{ts,tsx,css,md,json}", "/docs/**/*.md", "/index.html"], {
    query: "?url",
    import: "default",
    eager: true,
  }),
).map((file) => file.replace(/^\//, ""));

const caps = {
  supports_slash: true,
  supports_resume: false,
  supports_questions: true,
  supports_tuning: true,
  supports_skills: true,
  supports_goals: true,
  supports_images: true,
  supports_queue: true,
  supports_plan: true,
  supports_review: true,
  changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
};

/**
 * Codex 预览目录。description 模拟 CLI 英文说明，界面不应画出来。
 * 首次进入显示 CLI `config/read` 的 model / model_reasoning_effort。
 */
const codexCatalog: AgentCatalog = {
  agent: "codex-cli",
  models: [
    {
      id: "gpt-6.1-sol",
      label: "GPT-6.1-Sol",
      description: "Latest workhorse model for coding and agent workflows",
      is_default: true,
      default_effort: "low",
      efforts: [
        { id: "low", description: "Lower latency" },
        { id: "medium", description: "Balances speed and quality" },
        { id: "high", description: "Deeper reasoning" },
      ],
    },
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      description: "Older fast and efficient model.",
      is_default: false,
      default_effort: "medium",
      efforts: [
        { id: "minimal", description: "Minimal" },
        { id: "low", description: "Lower latency" },
        { id: "medium", description: "Balances speed and quality" },
        { id: "high", description: "Deeper reasoning" },
        {
          id: "xhigh",
          description: "Maximum reasoning effort for the hardest problems",
          label: "Maximum reasoning",
        },
      ],
      service_tiers: [{ id: "fast", name: "Fast", description: "1.5 倍速度 / 用量更多", fast: true }],
    },
  ],
  skills: [],
  commands: [],
  capabilities: caps,
  configured_model: "gpt-5.4",
  configured_effort: "xhigh",
  cli_config_read: true,
};

/** Claude 预览目录。模型来自 `list_models` 的形状，不含 Codex / GPT id。 */
const claudeCatalog: AgentCatalog = {
  agent: "claude-code",
  models: [
    {
      id: "claude-sonnet-4-5",
      label: "Sonnet 4.5",
      description: "平衡",
      is_default: true,
      default_effort: "medium",
      efforts: [
        { id: "low", description: "更快" },
        { id: "medium", description: "平衡" },
        { id: "high", description: "更深" },
      ],
    },
    {
      id: "claude-opus-4-5",
      label: "Opus 4.5",
      description: "复杂任务",
      is_default: false,
      default_effort: "high",
      efforts: [
        { id: "high", description: "深" },
        { id: "max", description: "最高" },
      ],
    },
  ],
  skills: [],
  commands: [],
  capabilities: caps,
  configured_model: "claude-sonnet-4-5",
  configured_effort: "medium",
  thread_model: "claude-sonnet-4-5",
  thread_effort: "medium",
  cli_config_read: true,
};

const codexPermissionMenu: PermissionMenu = {
  network_access: true,
  writable_roots: true,
  permission_profiles: true,
  approve_for_me: true,
  title: "Update Model Permissions",
  notice: null,
  active: "ask",
  presets: [
    {
      id: "ask",
      label: "Ask for approval",
      description: "Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace",
      allows_extras: true,
    },
    {
      id: "approve-for-me",
      label: "Approve for me",
      description: "Only ask for actions detected as potentially unsafe",
      allows_extras: true,
    },
    {
      id: "full",
      label: "Full Access",
      description: "Use with caution: Codex can edit files outside this workspace and access the internet without approval",
      caution: true,
    },
    {
      id: "read-only",
      label: "Read Only",
      description: "Read workspace files, with approval required for edits or internet access",
      allows_extras: true,
    },
  ],
  profiles: [],
};

const claudePermissionMenu: PermissionMenu = {
  network_access: false,
  writable_roots: false,
  permission_profiles: false,
  approve_for_me: false,
  title: "权限",
  notice: null,
  active: "ask",
  presets: [
    { id: "full", label: "跳过权限检查", description: "", caution: true },
    { id: "ask", label: "询问批准", description: "" },
  ],
  profiles: [],
};

const liveGoal: SessionEvent = {
  id: "goal",
  session_id: "preview",
  seq: 1,
  ts: 1,
  kind: "goal",
  objective: "把预制体升级做完",
  status: "active",
  token_budget: 50000,
  tokens_used: 12500,
  time_used_seconds: 90,
};

/** 预览用的技能目录。不接 app-server，只给 `$` 菜单核对单行省略。 */
const previewSkills: AgentSkillOption[] = [
  {
    name: "documents",
    mention: "documents",
    label: "文档",
    description:
      "在仓库里查找并引用长文档。说明再长也只占一行，超出部分以省略号截断，行高不能被说明撑开。",
    path: "documents",
  },
  {
    name: "review",
    mention: "review",
    label: "审查",
    description: "检查当前改动",
    path: "review",
  },
];

type PreviewMenu = null | "model" | "access" | "attach";

export default function ComposerPreview() {
  const params = new URLSearchParams(window.location.search);
  const claude = params.get("agent") === "claude";
  const catalog = claude ? claudeCatalog : codexCatalog;
  const initialMenu = params.get("menu");
  const skillsOpen = params.get("skills") === "1";
  const [text, setText] = useState(skillsOpen ? "$" : "");
  const [caret, setCaret] = useState(skillsOpen ? 1 : 0);
  const [planOn, setPlanOn] = useState(false);
  const [goalDraft, setGoalDraft] = useState(false);
  const [goalLive, setGoalLive] = useState(params.get("goal") === "live");
  const showUsage = params.get("usage") === "1";
  const [tuning, setTuning] = useState<SessionTuning | undefined>();
  const [menu, setMenu] = useState<PreviewMenu>(
    initialMenu === "model" || initialMenu === "access" ? initialMenu : null,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const accessRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const accessMenuRef = useRef<HTMLDivElement>(null);
  const permissionMenu = claude ? claudePermissionMenu : codexPermissionMenu;
  const sandbox = emptySandbox("ask");
  const events = useMemo<SessionEvent[]>(() => {
    const rows: SessionEvent[] = [];
    if (planOn) {
      rows.push({
        id: "plan",
        session_id: "preview",
        seq: 2,
        ts: 2,
        kind: "collaboration-mode",
        mode: "plan",
      });
    }
    if (goalLive) rows.push(liveGoal);
    if (showUsage) {
      rows.push(
        {
          id: "usage-window",
          session_id: "preview",
          seq: 3,
          ts: 3,
          kind: "context-usage",
          source: "get_context_usage",
          percentage: 12.5,
          used_tokens: 1200,
          max_tokens: 8000,
          model: "claude-sonnet",
        },
        {
          id: "usage-turn",
          session_id: "preview",
          seq: 4,
          ts: 4,
          kind: "context-usage",
          source: "partial-usage",
          input_tokens: 8,
          output_tokens: 2,
        },
      );
    }
    return rows;
  }, [goalLive, planOn, showUsage]);
  const goal = activeGoal(events);
  const view = deriveComposerView({
    status: "completed",
    events,
    caps,
    permissionMenu,
    sandbox,
    commands: [],
    skills: previewSkills,
    catalog,
    tuning,
    catalogNotice: null,
    text,
    caret,
    editingId: null,
    fileCount: 0,
    goalDraft,
    goalLive,
    goal,
  });
  useComposerMenu(menu === "model", modelRef, modelMenuRef, () => setMenu(null));
  useComposerMenu(menu === "access", accessRef, accessMenuRef, () => setMenu(null));
  const rememberTuning = (next: SessionTuning) => {
    setTuning((current) => ({
      model: next.model,
      effort: next.effort,
      serviceTier: next.serviceTier === undefined ? current?.serviceTier : next.serviceTier,
    }));
  };

  const files = useMemo(
    () => (view.mentionQuery ? mentionFiles(workspaceFiles, view.mentionQuery) : []),
    [view.mentionQuery],
  );
  const query = atToken(text, caret);

  const remember = (value: string, element: HTMLTextAreaElement) => {
    setText(value);
    setCaret(element.selectionStart ?? value.length);
  };

  const choose = (target: "files" | "goal" | "plan" | { path: string }) => {
    if (typeof target !== "string") {
      const next = insertMention(text, caret, [target.path]);
      setText(next.text);
      setCaret(next.caret);
      return;
    }
    const cleared = clearAtToken(text, caret);
    setText(cleared.text);
    setCaret(cleared.caret);
    if (target === "goal") {
      if (view.goalOn) {
        setGoalDraft(false);
        setGoalLive(false);
        return;
      }
      setPlanOn(false);
      setGoalDraft(true);
    }
    if (target === "plan") {
      if (view.planOn) {
        setPlanOn(false);
        return;
      }
      setGoalDraft(false);
      setGoalLive(false);
      setPlanOn(true);
    }
  };

  return (
    <div
      className="flex min-h-screen flex-col justify-end bg-zinc-950 px-6 pb-10 text-zinc-200"
      data-composer-preview
      data-preview-agent={claude ? "claude-code" : "codex-cli"}
    >
      <div className="relative mx-auto w-full max-w-3xl">
        {view.skillOpen && (
          <SkillMenu
            matches={view.skillMatches}
            active={view.skillMatches[0]}
            hasCatalog
            skillsError={null}
            listedCount={previewSkills.length}
            onPick={() => {}}
          />
        )}
        {view.mentionOpen && (
          <MentionMenu
            mode={query ? "files" : "add"}
            active={0}
            goalSupport={view.goalSupport}
            planSupport={view.planSupport}
            files={files}
            pending={false}
            error={null}
            query={query ?? ""}
            onPick={choose}
          />
        )}
        <div className="min-w-0 rounded-[28px] border border-zinc-700/90 bg-zinc-900 shadow-lg shadow-black/20">
          <div className="min-w-0 overflow-hidden px-3 pt-3">
            {view.goalStatus ? (
              <p
                data-goal-status
                title={view.goalStatus}
                className="mb-1 truncate px-1 text-xs leading-5 text-fuchsia-300"
              >
                {view.goalStatus}
              </p>
            ) : null}
            <ComposerInput
              text={text}
              placeholder={view.placeholder}
              disabled={false}
              textareaRef={textareaRef}
              onChange={remember}
              onCaret={(element) => setCaret(element.selectionStart ?? element.value.length)}
              onPaste={() => {}}
              onKeyDown={() => {}}
            />
          </div>
          <div className="px-3 pb-2.5">
            <ComposerBar
              plusRef={plusRef}
              accessRef={accessRef}
              modelRef={modelRef}
              menu={menu}
              imagesOn={false}
              composerLocked={false}
              sandbox={sandbox}
              permissionMenu={permissionMenu}
              planChip={view.planOn}
              goalChip={view.goalOn}
              showModel
              hasCatalog
              modelButton={view.modelButton}
              modelName={view.modelName}
              effortLabel={view.effortLabel}
              editing={false}
              stopMode={false}
              sendDisabled={view.sendDisabled}
              onToggleMenu={(name) => {
                if (name === "model" || name === "access" || name === "attach") {
                  setMenu((current) => (current === name ? null : name));
                }
              }}
              onPickFiles={() => {}}
              onDismissPlan={() => setPlanOn(false)}
              onDismissGoal={() => {
                setGoalDraft(false);
                setGoalLive(false);
              }}
              onCancelEdit={() => {}}
              onSend={() => {}}
            />
          </div>
        </div>
      </div>
      {menu === "access" && (
        <AccessMenu
          menuRef={accessMenuRef}
          sandbox={sandbox}
          menu={permissionMenu}
          showNetwork={view.showNetwork}
          showWritable={view.showWritable}
          onPreset={() => {}}
          onProfile={() => {}}
          onNetwork={() => {}}
          onAddDir={() => {}}
          onRemoveDir={() => {}}
        />
      )}
      {menu === "model" && (
        <ModelMenu
          menuRef={modelMenuRef}
          models={catalog.models}
          modelId={view.selectedModel?.id}
          modelLabel={view.selectedModel?.label}
          effortId={view.selectedEffort}
          fastOn={view.fastOn}
          fastAvailable={view.fastAvailable}
          fastTip={view.fastTip}
          canReset={Boolean(view.baselineModelId)}
          onModel={(model) => rememberTuning(tuningForModel(model, view.selectedEffort, view.storedServiceTier))}
          onEffort={(effort) => {
            if (!view.selectedModel) return;
            rememberTuning({ model: view.selectedModel.id, effort });
          }}
          onFast={(enabled) => {
            if (!view.selectedModel) return;
            rememberTuning({
              model: view.selectedModel.id,
              effort: view.selectedEffort ?? effortForModel(view.selectedModel, view.selectedEffort),
              serviceTier: enabled ? fastTier(view.selectedModel)?.id ?? null : null,
            });
          }}
          onReset={() => {
            if (!view.baselineModelId) return;
            rememberTuning({
              model: view.baselineModelId,
              effort: view.baselineEffort ?? "",
              serviceTier: view.baselineServiceTier,
            });
          }}
        />
      )}
    </div>
  );
}
