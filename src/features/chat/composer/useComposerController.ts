import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { usePanelOptional } from "@/features/panel/core/PanelProvider";
import { baseName } from "@/shared/path";
import type { ReviewStart, Session, SessionEvent } from "@/types";
import {
  addComposerDir,
  chooseComposerEffort,
  chooseComposerFast,
  chooseComposerModel,
  resetComposerTuning,
  removeComposerDir,
  selectComposerPreset,
  selectComposerProfile,
  setComposerNetwork,
} from "./composer-access-run";
import {
  addComposerFiles,
  applyComposerSkill,
  applyComposerSlash,
  beginComposerEdit,
  cancelComposerEdit,
  handleComposerKey,
  pasteComposerImages,
  pickComposerFiles,
  rememberCaret,
  removeComposerQueued,
  runComposerSubmit,
  steerComposerQueued,
  type ComposerRun,
} from "./composer-run";
import { sandboxFromMenu } from "./access";
import { composerCaps, composerCommands, deriveComposerView } from "./composer-view";
import { toggleFollowUpQueueMode } from "./follow-up-queue-mode";
import type { ComposerHost } from "./host";
import { queueStripVisible } from "./queue-strip";
import { useComposerMenu } from "./useComposerMenu";
import { useFileDrop } from "./useFileDrop";
import { collaborationMode } from "./collaboration-mode";
import { composerTokens, liveFileRefs, type FileRef } from "./file-refs";
import { useGoalDraft } from "./useGoalDraft";
import { useMentionMenu } from "./useMentionMenu";
import { releaseSubmitOnEdit, submitFingerprint, type SubmitFlight } from "./submit-flight";
import { useReviewDismiss } from "./useReviewDismiss";

export function useComposerController(host: ComposerHost, session: Session, events: SessionEvent[]) {
  const [text, setText] = useState(() => host.initialText);
  const [fileRefs, setFileRefs] = useState<FileRef[]>(() => liveFileRefs(host.initialText, host.initialFileRefs));
  const [caret, setCaret] = useState(0);
  const [menu, setMenu] = useState<null | "access" | "model" | "attach">(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [skillIndex, setSkillIndex] = useState(0);
  const [dismissedPopup, setDismissedPopup] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const submitFlight = useRef<SubmitFlight | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const reviewRootRef = useRef<HTMLDivElement>(null);
  const accessRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const accessMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeReview = useCallback(() => setReviewOpen(false), []);
  useReviewDismiss(reviewOpen, reviewRootRef, closeReview);

  const caps = composerCaps(host.catalog, host.profile);
  const sandbox = host.sandbox ?? sandboxFromMenu(host.permissionMenu);
  const supportsGoals = Boolean(caps?.supports_goals);
  const goal = useGoalDraft(host, session.id, supportsGoals, events);
  const view = deriveComposerView({
    status: session.status,
    events,
    caps,
    permissionMenu: host.permissionMenu,
    sandbox,
    commands: composerCommands(host.catalog, host.profile),
    skills: host.catalog?.skills ?? [],
    catalog: host.catalog,
    tuning: host.tuning,
    catalogNotice: host.catalogNotice,
    text,
    caret,
    editingId,
    fileCount: host.files.length,
    snippetCount: host.snippets.length,
    goalDraft: goal.localGoal,
    goalLive: goal.live,
    goal: goal.snapshot,
    inputLocked: host.inputLocked,
    resumable: true,
  });
  const goalSupport = goal.publishError ? "unsupported" : view.goalSupport;
  // `@` 菜单和斜杠命令共用这两个动作，进入的状态和最终发出的内容一致。
  const enterGoal = () => {
    if (collaborationMode(events) === "plan") void host.setCollaborationMode("default");
    goal.enter();
  };
  const togglePlan = () => {
    if (view.planOn) {
      void host.setCollaborationMode("default");
      return;
    }
    goal.dismiss();
    void host.setCollaborationMode("plan");
  };
  const mentions = useMentionMenu({
    host,
    text,
    setText,
    caret,
    setCaret,
    fileRefs,
    setFileRefs,
    textareaRef,
    mentionOpen: view.mentionOpen,
    mentionAdd: view.mentionAdd,
    mentionQuery: view.mentionQuery,
    goalSupport,
    planSupport: view.planSupport,
    onGoal: enterGoal,
    onPlan: togglePlan,
  });
  // Esc 收起的是这一个过滤词下的菜单，接着打字会重新出现。
  const popupKey = view.slashOpen ? `slash:${view.token}` : view.skillOpen ? `skill:${view.skillQuery}` : null;
  const popupHidden = popupKey !== null && popupKey === dismissedPopup;
  const slashShown = view.slashOpen && !popupHidden;
  const skillShown = view.skillOpen && !popupHidden;
  const activeSlash = view.slashMatches[Math.min(slashIndex, view.slashMatches.length - 1)];
  const activeSkill = view.skillMatches[Math.min(skillIndex, Math.max(view.skillMatches.length - 1, 0))];

  useComposerMenu(menu === "access", accessRef, accessMenuRef, closeMenu);
  useComposerMenu(menu === "model", modelRef, modelMenuRef, closeMenu);
  useComposerMenu(menu === "attach", plusRef, attachMenuRef, closeMenu);

  useEffect(() => {
    setSlashIndex(0);
  }, [view.token]);

  useEffect(() => {
    setSkillIndex(0);
  }, [view.skillQuery]);

  useEffect(() => {
    if (goal.publishError) setNotice(goal.publishError);
  }, [goal.publishError]);

  useEffect(() => {
    submitFlight.current = releaseSubmitOnEdit(
      submitFlight.current,
      session.id,
      submitFingerprint({
        editingId,
        text,
        fileCount: host.files.length,
        snippetCount: host.snippets.length,
      }),
    );
  }, [host.files.length, host.snippets.length, editingId, session.id, text]);

  // 没发出去的字交给宿主保存，切会话、重启都在。
  const remember = host.rememberText;
  useEffect(() => {
    remember(text);
    // 同一会话里宿主每次渲染都是新的，只在字变了时写。
  }, [session.id, text]);

  // 框里删掉的引用不再带着；还在的和文字一起存。
  const live = liveFileRefs(text, fileRefs);
  const liveKey = live.map((ref) => `${ref.label}\t${ref.path}`).join("\n");
  useEffect(() => {
    if (live.length !== fileRefs.length) setFileRefs(live);
    host.rememberFileRefs(live);
  }, [session.id, liveKey]);

  const snippetCount = host.snippets.length;
  const seenSnippets = useRef(snippetCount);
  useEffect(() => {
    if (snippetCount > seenSnippets.current) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    seenSnippets.current = snippetCount;
  }, [snippetCount]);

  const planEvent = collaborationMode(events) === "plan";
  useEffect(() => {
    if (view.goalOn && planEvent) void host.setCollaborationMode("default");
  }, [planEvent, session.id, view.goalOn]);

  const run: ComposerRun = {
    host,
    flightKey: session.id,
    text,
    caret,
    fileRefs: live,
    editingId,
    setText,
    setCaret,
    setEditingId,
    setNotice,
    setMenu,
    setReviewOpen,
    setSlashIndex,
    setSkillIndex,
    slashShown,
    skillShown,
    dismissPopup: () => setDismissedPopup(popupKey),
    textareaRef,
    caps,
    view,
    goalDraft: goal.localGoal,
    exitGoal: goal.dismiss,
    togglePlan,
    enterGoal,
    supportsGoals,
    submitGoal: goal.submit,
    mentions,
    activeSlash,
    activeSkill,
    sandbox,
    skillMatches: view.skillMatches.length,
    slashMatches: view.slashMatches.length,
    submitFlight,
    holdUntilAccepted: host.draft,
  };

  const dragOver = useFileDrop(reviewRootRef, !view.composerLocked, (paths) =>
    addComposerFiles(
      run,
      paths.map((path) => ({ path, name: baseName(path) })),
    ),
  );
  const panel = usePanelOptional();

  return {
    text,
    setText,
    tokens: composerTokens(text, live, (host.catalog?.skills ?? []).map((skill) => skill.mention)),
    menu,
    setMenu,
    reviewOpen,
    notice,
    dragOver,
    editingId,
    textareaRef,
    reviewRootRef,
    accessRef,
    modelRef,
    plusRef,
    accessMenuRef,
    modelMenuRef,
    attachMenuRef,
    files: host.files,
    snippets: host.snippets,
    queue: host.queue,
    sandbox,
    catalogNotice: host.catalogNotice,
    view,
    activeSkill,
    slashIndex,
    slashShown,
    skillShown,
    rememberCaret: (element: HTMLTextAreaElement) => rememberCaret(setCaret, element),
    cancelEdit: () => cancelComposerEdit(run),
    applySlash: (command: Parameters<typeof applyComposerSlash>[1]) => applyComposerSlash(run, command),
    applySkill: (skill: Parameters<typeof applyComposerSkill>[1]) => applyComposerSkill(run, skill),
    submit: () => runComposerSubmit(run),
    pickFiles: () => pickComposerFiles(run),
    beginEdit: (item: { id: string; text: string; images?: string[] }) => beginComposerEdit(run, item),
    removeQueued: (id: string) => removeComposerQueued(run, id),
    queueStrip: queueStripVisible({ supportsQueue: view.queueOn, count: host.queue.length }),
    followUpQueueMode: host.followUpQueueMode,
    steerQueued: (id: string) => steerComposerQueued(run, id),
    toggleQueueMode: () => host.setFollowUpQueueMode(toggleFollowUpQueueMode(host.followUpQueueMode)),
    interrupt: () => host.interrupt(),
    dismissPlan: () => {
      void host.setCollaborationMode("default");
    },
    models: host.catalog?.models ?? [],
    hasCatalog: Boolean(host.catalog),
    skillsError: host.catalog?.skills_error ?? null,
    skillCount: host.catalog?.skills.length ?? 0,
    mentions,
    goalSupport,
    goalNotice: goal.publishError,
    dismissGoal: goal.dismiss,
    deleteGoal: () => {
      if (view.occupied || view.dead) return;
      const objective = goal.snapshot?.objective ?? "";
      goal.dismiss();
      setText((current) => (objective && current === objective ? "" : current));
      setCaret(0);
    },
    toggleGoalRun: () => {
      if (view.occupied || view.dead) return;
      if (view.goalStatus?.run === "pause") goal.setStatus("paused");
      else if (view.goalStatus?.run === "resume") goal.setStatus("active");
    },
    editGoal: () => {
      const objective = goal.snapshot?.objective;
      if (!objective || view.occupied || view.dead) return;
      setEditingId(null);
      goal.enter();
      setText(objective);
      setCaret(objective.length);
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        if (!element) return;
        element.focus();
        element.setSelectionRange(0, objective.length);
      });
    },
    startReview: (target: ReviewStart) => {
      setReviewOpen(false);
      void host.startReview(target).catch((error: unknown) => host.reportError(error));
    },
    addDir: () => addComposerDir(run),
    removeDir: (path: string) => removeComposerDir(run, path),
    selectPreset: (mode: Parameters<typeof selectComposerPreset>[1]) => selectComposerPreset(run, mode),
    selectProfile: (id: string) => selectComposerProfile(run, id),
    setNetwork: (enabled: boolean) => setComposerNetwork(run, enabled),
    chooseModel: (model: Parameters<typeof chooseComposerModel>[1]) => chooseComposerModel(run, model),
    chooseEffort: (effort: string) => chooseComposerEffort(run, effort),
    chooseFast: (enabled: boolean) => chooseComposerFast(run, enabled),
    resetTuning: () => resetComposerTuning(run),
    removeFile: (path: string) => host.removeAttachment(path),
    /** 非图片附件在右侧「打开文件」里预览。没有面板的宿主不给。 */
    openFile: panel ? (path: string) => panel.openHref(path) : undefined,
    removeSnippet: (id: string) => host.removeTextSnippet(id),
    onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => handleComposerKey(run, event),
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => pasteComposerImages(run, event),
  };
}
