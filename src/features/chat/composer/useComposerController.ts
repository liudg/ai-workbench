import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useWorkbench } from "@/store";
import { isDraftId, takeComposerText } from "@/store/draft-session";
import { composerShowsWorkContext, isStandaloneDraft, visibleProjects } from "@/store/standalone";
import type { ReviewStart, Session, SessionEvent, SessionSandbox } from "@/types";
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
  applyComposerSkill,
  applyComposerSlash,
  beginComposerEdit,
  cancelComposerEdit,
  handleComposerKey,
  interruptComposer,
  pasteComposerImages,
  pickComposerFiles,
  rememberCaret,
  removeComposerQueued,
  runComposerSubmit,
  stageComposerBlobs,
  steerComposerQueued,
  type ComposerRun,
} from "./composer-run";
import { sandboxFromMenu } from "./access";
import { composerCaps, composerCommands, deriveComposerView } from "./composer-view";
import { applyFollowUpQueueMode } from "./composer-backend";
import {
  browserFollowUpQueueModeStorage,
  readFollowUpQueueMode,
  readSessionFollowUpQueueMode,
  rememberFollowUpQueueMode,
  toggleFollowUpQueueMode,
  writeSessionFollowUpQueueMode,
} from "./follow-up-queue-mode";
import { queueStripVisible } from "./queue-strip";
import { useComposerMenu } from "./useComposerMenu";
import { useComposerFeeds } from "./useComposerFeeds";
import { useComposerActions, useComposerSession } from "./useComposerStore";
import { collaborationMode } from "./collaboration-mode";
import { useGoalDraft } from "./useGoalDraft";
import { useMentionMenu } from "./useMentionMenu";
import { useReviewDismiss } from "./useReviewDismiss";

export function useComposerController(session: Session, events: SessionEvent[]) {
  const actions = useComposerActions();
  const data = useComposerSession(session);
  const moveStandaloneDraft = useWorkbench((s) => s.moveStandaloneDraft);
  const workProjects = useWorkbench((s) => s.projects);
  const standalone =
    isStandaloneDraft(session.project_id) ||
    workProjects.some((project) => project.id === session.project_id && project.standalone);
  const draftSession = isDraftId(session.id);
  const [text, setText] = useState(() => {
    if (draftSession) return useWorkbench.getState().drafts[session.project_id]?.text ?? "";
    return takeComposerText(session.id) ?? "";
  });
  const [caret, setCaret] = useState(0);
  const [menu, setMenu] = useState<null | "access" | "model" | "attach">(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [skillIndex, setSkillIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [followUpQueueMode, setFollowUpQueueMode] = useState(() =>
    readFollowUpQueueMode(browserFollowUpQueueModeStorage(), session.id, session.agent),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
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

  const caps = composerCaps(data.catalog, data.profile);
  const permissionMenu = useComposerFeeds(session.id, session.agent, actions.loadCatalog);
  const inputLocked = useWorkbench(
    (s) => draftSession && s.drafts[session.project_id]?.phase === "creating",
  );
  const sandbox = data.sandbox ?? sandboxFromMenu(permissionMenu);
  const supportsGoals = Boolean(caps?.supports_goals);
  const goal = useGoalDraft(session.id, supportsGoals, events);
  const view = deriveComposerView({
    status: session.status,
    events,
    caps,
    permissionMenu,
    sandbox,
    commands: composerCommands(data.catalog, data.profile),
    skills: data.catalog?.skills ?? [],
    catalog: data.catalog,
    tuning: data.tuning,
    catalogNotice: data.catalogNotice,
    text,
    caret,
    editingId,
    fileCount: data.files.length,
    snippetCount: data.snippets.length,
    goalDraft: goal.localGoal,
    goalLive: goal.live,
    goal: goal.snapshot,
    inputLocked,
  });
  const goalSupport = goal.publishError ? "unsupported" : view.goalSupport;
  const mentions = useMentionMenu({
    projectId: session.project_id,
    text,
    setText,
    caret,
    setCaret,
    textareaRef,
    mentionOpen: view.mentionOpen,
    mentionAdd: view.mentionAdd,
    mentionQuery: view.mentionQuery,
    goalSupport,
    planSupport: view.planSupport,
    onGoal: () => {
      if (collaborationMode(events) === "plan") {
        void actions.setCollaborationMode(session.id, "default");
      }
      goal.enter();
    },
    onPlan: () => {
      if (view.planOn) {
        void actions.setCollaborationMode(session.id, "default");
        return;
      }
      goal.dismiss();
      void actions.setCollaborationMode(session.id, "plan");
    },
  });
  const activeSlash = view.slashMatches[Math.min(slashIndex, view.slashMatches.length - 1)];
  const activeSkill = view.skillMatches[Math.min(skillIndex, Math.max(view.skillMatches.length - 1, 0))];

  const applySandbox = useCallback(
    (next: SessionSandbox) => {
      actions.setSandbox(session.id, next);
    },
    [actions.setSandbox, session.id],
  );
  useComposerMenu(menu === "access", accessRef, accessMenuRef, closeMenu);
  useComposerMenu(menu === "model", modelRef, modelMenuRef, closeMenu);
  useComposerMenu(menu === "attach", plusRef, attachMenuRef, closeMenu);

  useLayoutEffect(() => {
    const storage = browserFollowUpQueueModeStorage();
    if (!readSessionFollowUpQueueMode(storage, session.id)) {
      writeSessionFollowUpQueueMode(
        storage,
        session.id,
        readFollowUpQueueMode(storage, session.id, session.agent),
      );
    }
  }, [session.agent, session.id]);

  useLayoutEffect(() => {
    if (!caps?.supports_queue) return;
    void applyFollowUpQueueMode(session.id, followUpQueueMode);
  }, [caps?.supports_queue, followUpQueueMode, session.id]);

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
    if (!draftSession) return;
    useWorkbench.getState().rememberDraftText(session.project_id, text);
  }, [draftSession, session.project_id, text]);

  const snippetCount = data.snippets.length;
  const seenSnippets = useRef(snippetCount);
  useEffect(() => {
    if (snippetCount > seenSnippets.current) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    seenSnippets.current = snippetCount;
  }, [snippetCount]);

  const planEvent = collaborationMode(events) === "plan";
  useEffect(() => {
    if (view.goalOn && planEvent) void actions.setCollaborationMode(session.id, "default");
  }, [actions.setCollaborationMode, planEvent, session.id, view.goalOn]);

  const run: ComposerRun = {
    sessionId: session.id,
    text,
    caret,
    editingId,
    setText,
    setCaret,
    setEditingId,
    setNotice,
    setMenu,
    setReviewOpen,
    setSlashIndex,
    setSkillIndex,
    textareaRef,
    actions,
    caps,
    view,
    goalDraft: goal.localGoal,
    exitGoal: goal.dismiss,
    supportsGoals,
    submitGoal: goal.submit,
    mentions,
    activeSlash,
    activeSkill,
    sandbox,
    projectPath: data.projectPath,
    skillMatches: view.skillMatches.length,
    slashMatches: view.slashMatches.length,
    holdUntilAccepted: draftSession,
  };

  return {
    text,
    setText,
    menu,
    setMenu,
    reviewOpen,
    setReviewOpen,
    notice,
    dragOver,
    setDragOver,
    editingId,
    textareaRef,
    reviewRootRef,
    accessRef,
    modelRef,
    plusRef,
    accessMenuRef,
    modelMenuRef,
    attachMenuRef,
    files: data.files,
    snippets: data.snippets,
    queue: data.queue,
    sandbox,
    catalogNotice: data.catalogNotice,
    view,
    activeSlash,
    activeSkill,
    slashIndex,
    caps,
    rememberCaret: (element: HTMLTextAreaElement) => rememberCaret(setCaret, element),
    cancelEdit: () => cancelComposerEdit(run),
    stageBlobs: (blobs: File[]) => stageComposerBlobs(run, blobs),
    applySlash: (command: Parameters<typeof applyComposerSlash>[1]) => applyComposerSlash(run, command),
    applySkill: (skill: Parameters<typeof applyComposerSkill>[1]) => applyComposerSkill(run, skill),
    submit: () => runComposerSubmit(run),
    pickFiles: () => pickComposerFiles(run),
    beginEdit: (item: { id: string; text: string; images?: string[] }) => beginComposerEdit(run, item),
    applySandbox,
    removeQueued: (id: string) => removeComposerQueued(run, id),
    queueStrip: queueStripVisible({ supportsQueue: view.queueOn, count: data.queue.length }),
    followUpQueueMode,
    steerQueued: (id: string) => steerComposerQueued(run, id),
    toggleQueueMode: () => {
      const next = toggleFollowUpQueueMode(followUpQueueMode);
      rememberFollowUpQueueMode(
        browserFollowUpQueueModeStorage(),
        session.id,
        session.agent,
        next,
      );
      setFollowUpQueueMode(next);
    },
    interrupt: () => interruptComposer(run),
    dismissPlan: () => {
      void actions.setCollaborationMode(session.id, "default");
    },
    models: data.catalog?.models ?? [],
    hasCatalog: Boolean(data.catalog),
    skillsError: data.catalog?.skills_error ?? null,
    skillCount: data.catalog?.skills.length ?? 0,
    mentions,
    goalSupport,
    goalNotice: goal.publishError,
    goalChip: view.goalOn,
    goalStatus: view.goalStatus,
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
      void actions.startReview(session.id, target);
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
    removeFile: (path: string) => actions.removeAttachment(session.id, path),
    dismissSnippets: () => {
      actions.clearTextSnippets(session.id);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => handleComposerKey(run, event),
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => pasteComposerImages(run, event),
    workContext: composerShowsWorkContext(standalone, draftSession)
      ? {
          projects: visibleProjects(workProjects).map((project) => ({
            id: project.id,
            name: project.name,
          })),
          canRetarget: true,
          onPickProject: (projectId: string) => moveStandaloneDraft(projectId),
        }
      : null,
  };
}
