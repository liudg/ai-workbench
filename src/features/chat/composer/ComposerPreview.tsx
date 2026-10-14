import { useMemo, useRef, useState } from "react";

import { emptySandbox, type AgentCatalog, type SessionEvent } from "@/types";
import { ComposerBar } from "./ComposerBar";
import { ComposerInput } from "./ComposerInput";
import { MentionMenu } from "./MentionMenu";
import { deriveComposerView } from "./composer-view";
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
 * 目录里的 isDefault 是产品默认（GPT-6.1-Sol · 低）。
 * 首次进入应显示 CLI `config/read` 的 model / model_reasoning_effort，这里用 gpt-5.4 · 高代替那份配置。
 * 预览不调用 app-server。`?goal=live` 只是一条已经记录的 thread/goal 快照，用来核对状态栏文案。
 * `?usage=1` 同样只放两条 context-usage 快照，核对窗口和本回合那一行。
 */
const catalog: AgentCatalog = {
  models: [
    {
      id: "gpt-6.1-sol",
      label: "GPT-6.1-Sol",
      description: "",
      is_default: true,
      default_effort: "low",
      efforts: [
        { id: "low", description: "" },
        { id: "high", description: "" },
      ],
    },
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      description: "",
      is_default: false,
      default_effort: "medium",
      efforts: [
        { id: "low", description: "" },
        { id: "medium", description: "" },
        { id: "high", description: "" },
      ],
    },
  ],
  skills: [],
  commands: [],
  capabilities: caps,
  configured_model: "gpt-5.4",
  configured_effort: "high",
  cli_config_read: true,
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

/**
 * 开发预览：真实菜单和芯片，文件来自本仓库的模块图。
 * 不接 app-server，所以这里没有技能目录，也不调用 thread/goal。
 */
export default function ComposerPreview() {
  const params = new URLSearchParams(window.location.search);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [planOn, setPlanOn] = useState(false);
  const [goalDraft, setGoalDraft] = useState(false);
  const [goalLive, setGoalLive] = useState(params.get("goal") === "live");
  const showUsage = params.get("usage") === "1";
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const accessRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
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
    permissionMenu: null,
    sandbox: emptySandbox(),
    commands: [],
    skills: [],
    catalog,
    tuning: undefined,
    catalogNotice: null,
    text,
    caret,
    editingId: null,
    fileCount: 0,
    goalDraft,
    goalLive,
    goal,
  });
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
    <div className="flex min-h-screen flex-col justify-end bg-zinc-950 px-6 pb-10 text-zinc-200" data-composer-preview>
      <div className="relative mx-auto w-full max-w-3xl">
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
            {view.goalStatus || view.contextUsage ? (
              <div className="mb-1 flex min-w-0 items-center gap-3 px-1">
                {view.goalStatus ? (
                  <p data-goal-status title={view.goalStatus} className="min-w-0 truncate text-xs leading-5 text-fuchsia-300">
                    {view.goalStatus}
                  </p>
                ) : null}
                {view.contextUsage ? (
                  <p data-context-usage title={view.contextUsage} className="min-w-0 truncate text-xs leading-5 text-zinc-400">
                    {view.contextUsage}
                  </p>
                ) : null}
              </div>
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
              menu={null}
              imagesOn={false}
              composerLocked={false}
              sandbox={emptySandbox()}
              permissionMenu={null}
              planChip={view.planOn}
              goalChip={view.goalOn}
              showModel
              hasCatalog
              modelButton={view.modelButton}
              editing={false}
              stopMode={false}
              sendDisabled={view.sendDisabled}
              onToggleMenu={() => {}}
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
    </div>
  );
}
