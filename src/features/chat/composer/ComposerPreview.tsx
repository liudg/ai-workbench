import { useMemo, useRef, useState } from "react";

import { emptySandbox, type SessionEvent } from "@/types";
import { ComposerBar } from "./ComposerBar";
import { ComposerInput } from "./ComposerInput";
import { MentionMenu } from "./MentionMenu";
import { atToken, clearAtToken, insertMention, mentionFiles } from "./mentions";
import { deriveComposerView } from "./composer-view";

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
 * 开发预览：真实菜单和芯片，文件来自本仓库的模块图。
 * 不接 app-server，所以这里没有技能目录，也不调用 thread/goal。
 */
export default function ComposerPreview() {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [planOn, setPlanOn] = useState(false);
  const [goalDraft, setGoalDraft] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const accessRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const events = useMemo<SessionEvent[]>(
    () =>
      planOn
        ? [
            {
              id: "plan",
              session_id: "preview",
              seq: 1,
              ts: 1,
              kind: "collaboration-mode",
              mode: "plan",
            },
          ]
        : [],
    [planOn],
  );
  const view = deriveComposerView({
    status: "completed",
    events,
    caps,
    permissionMenu: null,
    sandbox: emptySandbox(),
    commands: [],
    skills: [],
    catalog: undefined,
    tuning: undefined,
    catalogNotice: null,
    text,
    caret,
    editingId: null,
    fileCount: 0,
    goalDraft,
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
    if (target === "goal") setGoalDraft((current) => !current);
    if (target === "plan") setPlanOn((current) => !current);
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
              planChip={planOn}
              goalChip={goalDraft}
              showModel={false}
              hasCatalog={false}
              modelButton=""
              editing={false}
              stopMode={false}
              sendDisabled={view.sendDisabled}
              onToggleMenu={() => {}}
              onPickFiles={() => {}}
              onDismissPlan={() => setPlanOn(false)}
              onDismissGoal={() => setGoalDraft(false)}
              onCancelEdit={() => {}}
              onSend={() => {}}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
