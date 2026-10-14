import { useMemo, useRef, useState } from "react";

import { useMemo, useRef, useState } from "react";

import { emptySandbox, type AgentCatalog, type AgentSkillOption, type SessionEvent, type SessionTuning } from "@/types";
import { ComposerBar } from "./ComposerBar";
import { ComposerInput } from "./ComposerInput";
import { MentionMenu } from "./MentionMenu";
import { ModelMenu } from "./ModelMenu";
import { SkillMenu } from "./SkillMenu";
import { deriveComposerView } from "./composer-view";
import { effortForModel } from "./composer-submit";
import { FAST_TIER_ID, tuningForModel } from "./model-picker";
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
 * 鐩綍閲岀殑 isDefault 鏄骇鍝侀粯璁わ紙GPT-6.1-Sol 浣庯級銆?
 * 棣栨杩涘叆搴旀樉绀?CLI `config/read` 鐨?model / model_reasoning_effort锛岃繖閲岀敤 gpt-5.4 楂樹唬鏇块偅浠介厤缃€?
 * 鎺ㄧ悊妗ｅ拰 Fast 妗ｆ槸 `model/list` 鐨勫瓧娈靛舰鐘讹紝棰勮涓嶈皟鐢?app-server銆?
 * `?goal=live` 鍙槸涓€鏉″凡缁忚褰曠殑 thread/goal 蹇収锛岀敤鏉ユ牳瀵圭姸鎬佹爮鏂囨銆?
 */
const catalog: AgentCatalog = {
  models: [
    {
      id: "gpt-6.1-sol",
      label: "GPT-6.1-Sol",
      description: "鏃ュ父缂栫爜",
      is_default: true,
      default_effort: "low",
      efforts: [
        { id: "low", description: "" },
        { id: "medium", description: "" },
        { id: "high", description: "" },
      ],
    },
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      description: "閰嶇疆閲岀殑妯″瀷",
      is_default: false,
      default_effort: "medium",
      efforts: [
        { id: "minimal", description: "" },
        { id: "low", description: "" },
        { id: "medium", description: "" },
        { id: "high", description: "" },
        { id: "xhigh", description: "" },
      ],
      service_tiers: [{ id: "fast", name: "Fast", description: "" }],
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
  objective: "鎶婇鍒朵綋鍗囩骇鍋氬畬",
  status: "active",
  token_budget: 50000,
  tokens_used: 12500,
  time_used_seconds: 90,
};

/** 棰勮鐢ㄧ殑鎶€鑳界洰褰曘€備笉鎺?app-server锛屽彧缁?`$` 鑿滃崟鏍稿鎹㈣銆?*/
const previewSkills: AgentSkillOption[] = [
  {
    name: "documents",
    mention: "documents",
    label: "鏂囨。",
    description: "鍦ㄤ粨搴撻噷鏌ユ壘骞跺紩鐢ㄩ暱鏂囨。銆傝鏄庡彲浠ユ崲琛岋紝鎶€鑳藉悕蹇呴』鐣欏湪鍚屼竴琛岋紝涓嶈兘浠庡崟璇嶄腑闂存柇寮€銆?,
    path: "documents",
  },
  {
    name: "review",
    mention: "review",
    label: "瀹℃煡",
    description: "妫€鏌ュ綋鍓嶆敼鍔?,
    path: "review",
  },
];

/**
 * 寮€鍙戦瑙堬細鐪熷疄鑿滃崟鍜岃姱鐗囷紝鏂囦欢鏉ヨ嚜鏈粨搴撶殑妯″潡鍥俱€?
 * 涓嶆帴 app-server锛屼篃涓嶈皟鐢?thread/goal銆?
 */
export default function ComposerPreview() {
  const params = new URLSearchParams(window.location.search);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [planOn, setPlanOn] = useState(false);
  const [goalDraft, setGoalDraft] = useState(false);
  const [goalLive, setGoalLive] = useState(params.get("goal") === "live");
  const [tuning, setTuning] = useState<SessionTuning | undefined>();
  const [menu, setMenu] = useState<null | "model">(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const accessRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
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
    return rows;
  }, [goalLive, planOn]);
  const goal = activeGoal(events);
  const view = deriveComposerView({
    status: "completed",
    events,
    caps,
    permissionMenu: null,
    sandbox: emptySandbox(),
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
    <div className="flex min-h-screen flex-col justify-end bg-zinc-950 px-6 pb-10 text-zinc-200" data-composer-preview>
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
              onToggleMenu={(name) => {
                if (name === "model") setMenu((current) => (current === "model" ? null : "model"));
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
      {menu === "model" && (
        <ModelMenu
          menuRef={modelMenuRef}
          models={catalog.models}
          modelId={view.selectedModel?.id}
          modelLabel={view.selectedModel?.label}
          effortId={view.selectedEffort}
          fastOn={view.fastOn}
          fastAvailable={view.fastAvailable}
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
              serviceTier: enabled ? FAST_TIER_ID : null,
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
