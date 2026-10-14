import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { ReviewStart, Session, SessionEvent, SessionSandbox } from "@/types";
import {
  addComposerDir,
  chooseComposerEffort,
  chooseComposerModel,
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
  type ComposerRun,
} from "./composer-run";
import { deriveComposerView } from "./composer-view";
import { useComposerMenu } from "./useComposerMenu";
import { useComposerFeeds } from "./useComposerFeeds";
import { useComposerActions, useComposerSession } from "./useComposerStore";
import { collaborationMode } from "./collaboration-mode";
import { appendSnippet, subscribeComposerInsert } from "@/shared/composer-insert";
import { useGoalDraft } from "./useGoalDraft";
import { useMentionMenu } from "./useMentionMenu";
import { useReviewDismiss } from "./useReviewDismiss";

export function useComposerController(session: Session, events: SessionEvent[]) {
  const actions = useComposerActions();
  const data = useComposerSession(session);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [menu, setMenu] = useState<null | "access" | "model" | "attach">(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [skillIndex, setSkillIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
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

  const caps = data.profile?.capabilities ?? data.catalog?.capabilities;
  const permissionMenu = useComposerFeeds(session.id, actions.loadCatalog);
  const supportsGoals = Boolean(caps?.supports_goals);
  const goal = useGoalDraft(session.id, supportsGoals, events);
  const view = deriveComposerView({
    status: session.status,
    events,
    caps,
    permissionMenu,
    sandbox: data.sandbox,
    commands: data.catalog?.commands ?? data.profile?.commands ?? [],
    skills: data.catalog?.skills ?? [],
    catalog: data.catalog,
    tuning: data.tuning,
    catalogNotice: data.catalogNotice,
    text,
    caret,
    editingId,
    fileCount: data.files.length,
    goalDraft: goal.localGoal,
    goalLive: goal.live,
    goal: goal.snapshot,
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
    return subscribeComposerInsert(session.id, (snippet) => {
      setText((current) => appendSnippet(current, snippet));
      requestAnimationFrame(() => textareaRef.current?.focus());
    });
  }, [session.id, textareaRef]);

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
    sandbox: data.sandbox,
    projectPath: data.projectPath,
    skillMatches: view.skillMatches.length,
    slashMatches: view.slashMatches.length,
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
    queue: data.queue,
    sandbox: data.sandbox,
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
    removeFile: (path: string) => actions.removeAttachment(session.id, path),
    onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => handleComposerKey(run, event),
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => pasteComposerImages(run, event),
  };
}
