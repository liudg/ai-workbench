// 任务里的作曲栏：输入、发送、停止、排队、模型和权限。选项写进 daemon，重开、换窗口都在。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import { sandboxFromMenu, addWritableRoot, removeWritableRoot, selectPreset, selectProfile, setNetwork } from "@/features/chat/composer/access";
import { composerKeyIntent, stepIndex } from "@/features/chat/composer/composer-keys";
import { decideSlash, decideSubmit } from "@/features/chat/composer/composer-submit";
import { composerCaps, composerCommands, deriveComposerView } from "@/features/chat/composer/composer-view";
import { toggleFollowUpQueueMode, type FollowUpQueueMode } from "@/features/chat/composer/follow-up-queue-mode";
import { fastTier, tuningForModel } from "@/features/chat/composer/model-picker";
import { isImagePath } from "@/features/chat/composer/media";
import { useComposerMenu } from "@/features/chat/composer/useComposerMenu";
import { useReviewDismiss } from "@/features/chat/composer/useReviewDismiss";
import type { SessionOptions, TaskSession } from "@/features/tasks";
import { userFacingMessage } from "@/lib/user-facing";
import { pickFiles } from "@/lib/native/pick-files";
import { pickFolder } from "@/lib/native/pick-folder";
import { stageImage } from "@/lib/native/stage-image";
import type {
  AgentCatalog,
  AgentModelOption,
  AgentProfile,
  Attachment,
  PermissionMenu,
  QueuedTurn,
  ReviewStart,
  Session,
  SessionEvent,
  SessionSandbox,
  SessionTuning,
  SlashCommand,
} from "@/types";
import {
  agentCatalog,
  answerPrompt,
  interruptTurn,
  removeQueued,
  sendMessage,
  sessionPermissionMenu,
  setSessionOptions,
  startReview,
  steerQueued,
  updateQueued,
} from "./task-backend";
import {
  addTaskAttachments,
  clearTaskSnippets,
  setTaskAttachments,
  setTaskSnippets,
  useTaskAttachments,
  useTaskSnippets,
} from "./task-composer-store";

/** 切任务时留住没发出的字。 */
const drafts = new Map<string, string>();

function toSandbox(options: SessionOptions): SessionSandbox | null {
  const access = options.access;
  if (!access) return null;
  return {
    mode: access.mode as SessionSandbox["mode"],
    networkAccess: access.networkAccess,
    writableRoots: access.writableRoots,
    profileId: access.profileId,
  };
}

function toTuning(options: SessionOptions): SessionTuning | undefined {
  if (!options.model) return undefined;
  const tuning: SessionTuning = { model: options.model, effort: options.effort ?? "" };
  if (options.serviceTier !== undefined) tuning.serviceTier = options.serviceTier || null;
  return tuning;
}

export function useTaskComposer({
  session,
  taskSession,
  events,
  queue,
  profile,
}: {
  session: Session;
  taskSession: TaskSession;
  events: SessionEvent[];
  queue: QueuedTurn[];
  profile: AgentProfile | undefined;
}) {
  const sessionId = session.id;
  const options = taskSession.options;
  const [text, setTextState] = useState(() => drafts.get(sessionId) ?? "");
  const [caret, setCaret] = useState(0);
  const files = useTaskAttachments(sessionId);
  const setFiles = useCallback((list: Attachment[]) => setTaskAttachments(sessionId, list), [sessionId]);
  const snippets = useTaskSnippets(sessionId);
  const [menu, setMenu] = useState<null | "access" | "model" | "attach">(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<AgentCatalog | undefined>(undefined);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const [permissionMenu, setPermissionMenu] = useState<PermissionMenu | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const accessRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const accessMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const reviewRootRef = useRef<HTMLDivElement>(null);

  const setText = useCallback(
    (value: string) => {
      setTextState(value);
      if (value) drafts.set(sessionId, value);
      else drafts.delete(sessionId);
    },
    [sessionId],
  );

  useEffect(() => {
    let cancelled = false;
    void agentCatalog(taskSession.agent, sessionId)
      .then((next) => {
        if (!cancelled) setCatalog(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setCatalogNotice(userFacingMessage(error));
      });
    void sessionPermissionMenu(sessionId)
      .then((next) => {
        if (!cancelled) setPermissionMenu(next);
      })
      .catch(() => {
        if (!cancelled) setPermissionMenu(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, taskSession.agent]);

  const closeMenu = useCallback(() => setMenu(null), []);
  useComposerMenu(menu === "access", accessRef, accessMenuRef, closeMenu);
  useComposerMenu(menu === "model", modelRef, modelMenuRef, closeMenu);
  useComposerMenu(menu === "attach", plusRef, attachMenuRef, closeMenu);
  const closeReview = useCallback(() => setReviewOpen(false), []);
  useReviewDismiss(reviewOpen, reviewRootRef, closeReview);

  const report = useCallback((error: unknown) => setNotice(userFacingMessage(error)), []);

  const caps = composerCaps(catalog, profile);
  const commands = composerCommands(catalog, profile);
  const sandbox = toSandbox(options) ?? sandboxFromMenu(permissionMenu);
  const view = deriveComposerView({
    status: session.status,
    events,
    caps,
    permissionMenu,
    sandbox,
    commands,
    skills: [],
    catalog,
    tuning: toTuning(options),
    catalogNotice,
    text,
    caret,
    editingId,
    fileCount: files.length,
    snippetCount: snippets.length,
    goalDraft: false,
    resumable: true,
  });
  const followUpQueueMode: FollowUpQueueMode = options.followUpQueueMode === "steer" ? "steer" : "queue";

  const writeOptions = useCallback(
    (patch: Partial<SessionOptions>) => {
      void setSessionOptions(sessionId, { ...options, ...patch }).catch(report);
    },
    [options, report, sessionId],
  );

  const writeSandbox = (next: SessionSandbox) => writeOptions({ access: { ...next } });
  const baseSandbox = (): SessionSandbox =>
    sandbox ?? { mode: "full", networkAccess: false, writableRoots: [], profileId: "" };

  const focus = () => textareaRef.current?.focus();

  const submit = (now = false) => {
    const decision = decideSubmit({
      text,
      supportsPlan: Boolean(caps?.supports_plan),
      supportsReview: Boolean(caps?.supports_review),
      planOn: view.planOn,
      imagesOn: view.imagesOn,
      attached: files,
      snippets,
      editingId,
      pendingId: view.pendingId,
      pendingKind: view.pendingKind,
      composerLocked: view.composerLocked,
      goalDraft: false,
      supportsGoals: false,
    });
    setNotice(null);
    // 引用片段已经并进正文，发出去就清掉。
    if ("clearSnippets" in decision && decision.clearSnippets) clearTaskSnippets(sessionId);
    switch (decision.type) {
      case "noop":
      case "set-goal":
        return;
      case "open-review":
        setText("");
        setReviewOpen(true);
        return;
      case "toggle-plan":
        setText("");
        writeOptions({ collaborationMode: decision.mode });
        return;
      case "plan-message":
        setText("");
        void setSessionOptions(sessionId, { ...options, collaborationMode: "plan" })
          .then(() => sendMessage(sessionId, decision.text, [], now))
          .catch(report);
        return;
      case "update-queue": {
        setEditingId(null);
        setText("");
        setFiles([]);
        const work = now
          ? sendMessage(sessionId, decision.text, decision.images, true).then(() => removeQueued(sessionId, decision.id))
          : updateQueued(sessionId, decision.id, decision.text, decision.images);
        void work.catch(report);
        focus();
        return;
      }
      case "answer":
        setText("");
        void answerPrompt(sessionId, decision.promptId, { type: "single", value: decision.text }).catch(report);
        focus();
        return;
      default: {
        const images = decision.type === "send-images" ? decision.images : [];
        const clearFiles = decision.type === "send-images" || decision.clearAttachments;
        const previous = text;
        const previousFiles = files;
        const previousSnippets = snippets;
        setText("");
        if (clearFiles) setFiles([]);
        void sendMessage(sessionId, decision.text, images, now).catch((error: unknown) => {
          // 没发出去：把字放回去，别让用户重打。
          setText(previous);
          setFiles(previousFiles);
          setTaskSnippets(sessionId, previousSnippets);
          report(error);
        });
        focus();
      }
    }
  };

  const interrupt = () => {
    void interruptTurn(sessionId).catch(report);
  };

  const applySlash = (command: SlashCommand) => {
    const decision = decideSlash(command, caps, view.planOn);
    if (decision.type === "review") {
      setText("");
      setReviewOpen(true);
      return;
    }
    if (decision.type === "toggle-plan") {
      setText("");
      writeOptions({ collaborationMode: decision.mode });
      return;
    }
    if (decision.type === "fill") {
      setText(decision.text);
      setCaret(decision.text.length);
      focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const active = view.slashMatches[Math.min(slashIndex, view.slashMatches.length - 1)];
    const intent = composerKeyIntent({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      repeat: event.repeat,
      composing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
      editing: Boolean(editingId),
      skillOpen: false,
      hasActiveSkill: false,
      slashOpen: view.slashOpen,
      hasActiveSlash: Boolean(active),
      token: view.token,
      activeSlashName: active?.name,
      text,
      skillQuery: null,
      mentionOpen: false,
      hasActiveMention: false,
    });
    if (!intent) return;
    switch (intent.type) {
      case "submit":
      case "submit-now":
        event.preventDefault();
        if (view.stopMode && intent.type === "submit") return;
        submit(intent.type === "submit-now");
        return;
      case "cancel-edit":
        event.preventDefault();
        setEditingId(null);
        setText("");
        return;
      case "slash-move":
        event.preventDefault();
        setSlashIndex((current) => stepIndex(current, view.slashMatches.length, intent.key));
        return;
      case "apply-slash":
        event.preventDefault();
        if (active) applySlash(active);
        return;
      default:
        return;
    }
  };

  /** 粘贴或拖进来的图片存好再放进附件。不是图片的不收。 */
  const stageBlobs = async (blobs: File[]) => {
    const images = blobs.filter((file) => file.type.startsWith("image/") || isImagePath(file.name));
    if (images.length < blobs.length) setNotice("只能附加图片");
    if (images.length === 0) return;
    try {
      const staged = await Promise.all(images.map((file) => stageImage(file)));
      addTaskAttachments(sessionId, staged);
    } catch (error) {
      report(error);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!view.imagesOn || view.composerLocked) return;
    const blobs = Array.from(event.clipboardData.files);
    if (blobs.length === 0) return;
    event.preventDefault();
    void stageBlobs(blobs);
  };

  const dropTarget = {
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!view.imagesOn || view.composerLocked) return;
      event.preventDefault();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (!view.imagesOn || view.composerLocked) return;
      event.preventDefault();
      setDragOver(false);
      void stageBlobs(Array.from(event.dataTransfer.files));
    },
  };

  const chooseModel = (model: AgentModelOption) => {
    const next = tuningForModel(model, view.selectedEffort, view.storedServiceTier);
    // 速度档：undefined 是没动过，null 是关掉，写进 daemon 时关掉记成空串。
    const serviceTier = next.serviceTier === undefined ? options.serviceTier : (next.serviceTier ?? "");
    writeOptions({ model: next.model, effort: next.effort, serviceTier });
  };
  const chooseEffort = (effort: string) => {
    if (!view.selectedModel) return;
    writeOptions({ model: view.selectedModel.id, effort });
  };
  const chooseFast = (enabled: boolean) => {
    const model = view.selectedModel;
    const tier = fastTier(model);
    if (!model || !tier) return;
    writeOptions({
      model: model.id,
      effort: view.selectedEffort ?? model.default_effort,
      serviceTier: enabled ? tier.id : "",
    });
  };
  const resetTuning = () => writeOptions({ model: undefined, effort: undefined, serviceTier: undefined });

  return {
    text,
    setText,
    caret,
    rememberCaret: (element: HTMLTextAreaElement) => setCaret(element.selectionStart ?? element.value.length),
    files,
    removeFile: (path: string) => setFiles(files.filter((file) => file.path !== path)),
    snippets,
    dismissSnippets: () => clearTaskSnippets(sessionId),
    menu,
    setMenu,
    slashIndex,
    editingId,
    notice,
    catalogNotice,
    view,
    sandbox,
    models: catalog?.models ?? [],
    hasCatalog: Boolean(catalog),
    queue,
    followUpQueueMode,
    textareaRef,
    plusRef,
    accessRef,
    modelRef,
    accessMenuRef,
    modelMenuRef,
    attachMenuRef,
    submit: () => submit(false),
    interrupt,
    applySlash,
    onKeyDown,
    onPaste,
    dropTarget,
    dragOver,
    reviewOpen,
    reviewRootRef,
    startReview: (target: ReviewStart) => {
      setReviewOpen(false);
      void startReview(sessionId, target).catch(report);
    },
    pickFiles: async () => {
      setMenu(null);
      const picked = await pickFiles(view.imagesOn ? "选择图片或文件" : "选择文件");
      if (picked.length === 0) return;
      addTaskAttachments(sessionId, picked);
    },
    chooseModel,
    chooseEffort,
    chooseFast,
    resetTuning,
    dismissPlan: () => writeOptions({ collaborationMode: "default" }),
    selectPreset: (mode: SessionSandbox["mode"]) => writeSandbox(selectPreset(baseSandbox(), mode)),
    selectProfile: (id: string) => writeSandbox(selectProfile(baseSandbox(), id)),
    setNetwork: (enabled: boolean) => writeSandbox(setNetwork(baseSandbox(), enabled)),
    addDir: async () => {
      const path = await pickFolder("添加可写目录");
      if (path) writeSandbox(addWritableRoot(baseSandbox(), path));
    },
    removeDir: (path: string) => writeSandbox(removeWritableRoot(baseSandbox(), path)),
    steerQueued: (id: string) => void steerQueued(sessionId, id).catch(report),
    removeQueued: (id: string) => void removeQueued(sessionId, id).catch(report),
    beginEdit: (item: QueuedTurn) => {
      setEditingId(item.id);
      setText(item.text);
      focus();
    },
    cancelEdit: () => {
      setEditingId(null);
      setText("");
    },
    toggleQueueMode: () => writeOptions({ followUpQueueMode: toggleFollowUpQueueMode(followUpQueueMode) }),
  };
}

export type TaskComposerController = ReturnType<typeof useTaskComposer>;
