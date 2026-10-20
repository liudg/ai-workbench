import { useMemo, useRef, useState } from "react";

import {
  emptySandbox,
  type AgentCatalog,
  type AgentSkillOption,
  type PermissionMenu,
  type QueuedTurn,
  type SessionEvent,
  type SessionTuning,
} from "@/types";
import type { TextSnippet } from "@/shared/text-snippet";
import { AccessMenu } from "./AccessMenu";
import { ComposerBar } from "./ComposerBar";
import { ComposerInput } from "./ComposerInput";
import { TextSnippetChip, TextSnippetPreview } from "./TextSnippets";
import { MentionMenu } from "./MentionMenu";
import { ModelMenu } from "./ModelMenu";
import { SkillMenu } from "./SkillMenu";
import { deriveComposerView } from "./composer-view";
import { GoalStatusBar } from "./GoalStatusBar";
import { effortForModel } from "./composer-submit";
import { fastTier, tuningForModel } from "./model-picker";
import { useComposerMenu } from "./useComposerMenu";
import { activeGoal } from "./goal";
import { atToken, clearAtToken, insertMention, mentionFiles } from "./mentions";
import { QueuedMessageList } from "./QueueStrip";
import { toggleFollowUpQueueMode, type FollowUpQueueMode } from "./follow-up-queue-mode";

const workspaceFiles = Object.keys(
  import.meta.glob(["/src/**/*.{ts,tsx,md,json}", "/docs/**/*.md", "/index.html"], {
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
  supports_cancel: true,
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
  writable_roots: true,
  permission_profiles: false,
  approve_for_me: false,
  title: "权限",
  notice: null,
  active: "ask",
  presets: [
    { id: "full", label: "跳过权限检查", description: "", caution: true, allows_extras: true },
    { id: "ask", label: "询问批准", description: "", allows_extras: true },
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

const timeGoal: SessionEvent = {
  id: "goal",
  session_id: "preview",
  seq: 1,
  ts: 1,
  kind: "goal",
  objective: "开一个30秒的目标，什么都不干",
  status: "active",
  time_used_seconds: 3,
};

const previewSnippet: TextSnippet = {
  id: "preview-snippet",
  path: "Assets/Editor/Preview.cs",
  start: 12,
  end: 16,
  body: [
    "/// <summary>",
    "/// 传入物品 ID，根据物品类型打开不同预览界面。",
    "/// </summary>",
    '/// <param name="itemID"></param>',
    "public void OpenPreview(string itemID)",
  ].join("\n"),
  quote: [
    "```12:16:Assets/Editor/Preview.cs",
    "/// <summary>",
    "/// 传入物品 ID，根据物品类型打开不同预览界面。",
    "/// </summary>",
    '/// <param name="itemID"></param>',
    "public void OpenPreview(string itemID)",
    "```",
  ].join("\n"),
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

const previewQueued: QueuedTurn[] = [
  { id: "q1", text: "把登录失败的提示改成中文" },
  { id: "q2", text: "补上队列条的单元测试" },
];

export default function ComposerPreview() {
  const params = new URLSearchParams(window.location.search);
  const claude = params.get("agent") === "claude";
  const catalog = claude ? claudeCatalog : codexCatalog;
  const initialMenu = params.get("menu");
  const queueQuery = params.get("queue");
  const showQueue = Boolean(queueQuery) && Boolean(catalog.capabilities.supports_queue);
  const skillsOpen = params.get("skills") === "1";
  const showSnippets = params.get("snippets") === "1";
  const [snippets, setSnippets] = useState<TextSnippet[]>(() => (showSnippets ? [previewSnippet] : []));
  const [queued, setQueued] = useState<QueuedTurn[]>(() => {
    if (!showQueue) return [];
    if (queueQuery === "1") return previewQueued.slice(0, 1);
    return previewQueued;
  });
  const [followUpQueueMode, setFollowUpQueueMode] = useState<FollowUpQueueMode>(
    queueQuery === "steer" ? "steer" : "queue",
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [text, setText] = useState(skillsOpen ? "$" : "");
  const [caret, setCaret] = useState(skillsOpen ? 1 : 0);
  const [planOn, setPlanOn] = useState(() => params.get("plan") === "1");
  const [sent, setSent] = useState(() => params.get("sent") === "1");
  const goalPreview = params.get("goal");
  const [goalDraft, setGoalDraft] = useState(() => params.get("goal") === "draft");
  const [goalLive, setGoalLive] = useState(goalPreview === "live" || goalPreview === "time");
  const [goalRun, setGoalRun] = useState<string | null>(null);
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
  const access = params.get("access");
  const sandbox = emptySandbox(
    access === "full" || access === "read-only" || access === "approve-for-me" ? access : "ask",
  );
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
    if (goalLive) {
      const source = goalPreview === "time" ? timeGoal : liveGoal;
      if (source.kind === "goal") rows.push({ ...source, status: goalRun ?? source.status });
    }
    if (sent) {
      rows.push({
        id: "sent",
        session_id: "preview",
        seq: 3,
        ts: 3,
        kind: "user-message",
        text: "已发送",
      });
    }
    return rows;
  }, [goalLive, goalPreview, goalRun, planOn, sent]);
  const goal = activeGoal(events);
  const view = deriveComposerView({
    status: showQueue ? "running" : "completed",
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
    snippetCount: snippets.length,
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
        setGoalRun(null);
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
      className="flex min-h-screen flex-col justify-end bg-[#0f0f0f] px-4 pb-4 text-[#e8e8e8]"
      data-composer-preview
      data-preview-agent={claude ? "claude-code" : "codex-cli"}
    >
      <div className="relative w-full">
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
        {view.goalStatus ? (
          <GoalStatusBar
            model={view.goalStatus}
            onDelete={() => {
              const objective = goal?.objective ?? "";
              setGoalDraft(false);
              setGoalLive(false);
              setGoalRun(null);
              setText((current) => (objective && current === objective ? "" : current));
            }}
            onToggleRun={() => {
              if (view.goalStatus?.run === "pause") setGoalRun("paused");
              else if (view.goalStatus?.run === "resume") setGoalRun("active");
            }}
            onEdit={() => {
              const objective = goal?.objective;
              if (!objective) return;
              setGoalDraft(true);
              setText(objective);
              setCaret(objective.length);
              requestAnimationFrame(() => {
                textareaRef.current?.focus();
                textareaRef.current?.setSelectionRange(0, objective.length);
              });
            }}
          />
        ) : null}
        {snippets.length > 0 ? (
          <div className="mb-2">
            <p className="px-2 text-sm text-[#bdbdbd]">先看这个入口。</p>
            <div className="h-28" />
          </div>
        ) : null}
        <div className="relative min-w-0">
        <TextSnippetPreview snippets={snippets} />
        <div className="min-w-0 rounded-[18px] border border-[#2a2a2a] bg-[#171717]">
          {showQueue && queued.length > 0 ? (
            <QueuedMessageList
              items={queued}
              mode={followUpQueueMode}
              editingId={editingId}
              canOpenSideChat={false}
              defaultMenuOpen={queueQuery === "menu"}
              onSteer={(id) => {
                setQueued((current) => current.filter((item) => item.id !== id));
                setEditingId((current) => (current === id ? null : current));
              }}
              onRemove={(id) => {
                setQueued((current) => current.filter((item) => item.id !== id));
                if (editingId === id) {
                  setEditingId(null);
                  setText("");
                  setCaret(0);
                }
              }}
              onEdit={(item) => {
                setEditingId(item.id);
                setText(item.text);
                setCaret(item.text.length);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
              onToggleQueueMode={() => setFollowUpQueueMode((current) => toggleFollowUpQueueMode(current))}
            />
          ) : null}
          <div className="min-w-0 overflow-hidden px-3 pt-3">
            <TextSnippetChip snippets={snippets} onClear={() => setSnippets([])} />
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
              planIndicator={view.planIndicator}
              goalChip={view.goalChip}
              showModel
              hasCatalog
              modelButton={view.modelButton}
              modelName={view.modelName}
              effortLabel={view.effortLabel}
              editing={false}
              stopMode={view.stopMode}
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
              onSend={() => {
                if (!text.trim() && !goalDraft) return;
                const submittingGoal = goalDraft;
                setSent(true);
                setText("");
                setCaret(0);
                setGoalDraft(false);
                if (submittingGoal) setGoalLive(true);
              }}
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
    </div>
  );
}
