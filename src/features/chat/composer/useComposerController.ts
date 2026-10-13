import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useWorkbench } from "@/store";
import type {
  AgentModelOption,
  AgentSkillOption,
  PermissionMenu,
  ReviewStart,
  Session,
  SessionEvent,
  SessionSandbox,
  SlashCommand,
} from "@/types";
import { fileName, isImagePath } from "./media";
import { insertSkill } from "./skills";
import {
  fetchPermissionMenu,
  fetchQueue,
  interruptTurn,
  pickAttachments,
  pickWritableDirectory,
  removeQueuedTurn,
  stageChatImage,
  storeQueue,
  updateQueuedTurn,
} from "./composer-backend";
import { composerKeyIntent, stepIndex } from "./composer-keys";
import { decideSlash, decideSubmit, effortForModel } from "./composer-submit";
import { deriveComposerView } from "./composer-view";
import { useComposerMenu } from "./useComposerMenu";
import { useComposerActions, useComposerSession } from "./useComposerStore";
import { addWritableRoot, removeWritableRoot, selectPreset, selectProfile, setNetwork } from "./access";
import { useGoalDraft } from "./useGoalDraft";
import { useMentionMenu } from "./useMentionMenu";

export function useComposerController(session: Session, events: SessionEvent[]) {
  const actions = useComposerActions();
  const data = useComposerSession(session);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [menu, setMenu] = useState<null | "access" | "model" | "attach">(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [permissionMenu, setPermissionMenu] = useState<PermissionMenu | null>(null);
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
  useEffect(() => {
    if (!reviewOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeReview();
    };
    const onPointer = (event: MouseEvent) => {
      // 选项的 mousedown 会立刻换掉菜单内容。旧节点已脱离文档时，
      // contains 判断会把这次点击当成菜单外。选项自己 preventDefault。
      if (event.defaultPrevented) return;
      if (reviewRootRef.current?.contains(event.target as Node)) return;
      closeReview();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [reviewOpen, closeReview]);

  const caps = data.profile?.capabilities ?? data.catalog?.capabilities;
  const supportsGoals = Boolean(caps?.supports_goals);
  const goal = useGoalDraft(session.id, supportsGoals, events);
  const view = deriveComposerView({
    status: session.status,
    events,
    caps,
    permissionMenu,
    sandbox: data.sandbox,
    commands: data.profile?.commands ?? data.catalog?.commands ?? [],
    skills: data.catalog?.skills ?? [],
    catalog: data.catalog,
    tuning: data.tuning,
    catalogNotice: data.catalogNotice,
    text,
    caret,
    editingId,
    fileCount: data.files.length,
    goalDraft: goal.goalDraft,
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
    onGoal: goal.toggleDraft,
    onPlan: () => {
      void actions.setCollaborationMode(session.id, view.planOn ? "default" : "plan");
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
    void actions.loadCatalog(session.id);
  }, [actions.loadCatalog, session.id]);

  useEffect(() => {
    let cancelled = false;
    void fetchQueue(session.id)
      .then((items) => {
        if (!cancelled) storeQueue(session.id, items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  useEffect(() => {
    if (!caps?.supports_network_access && !caps?.supports_writable_roots) return;
    let cancelled = false;
    void fetchPermissionMenu(session.id)
      .then((next) => {
        if (!cancelled) setPermissionMenu(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [caps?.supports_network_access, caps?.supports_writable_roots, session.id]);

  useEffect(() => {
    setSlashIndex(0);
  }, [view.token]);

  useEffect(() => {
    setSkillIndex(0);
  }, [view.skillQuery]);

  useEffect(() => {
    if (goal.publishError) setNotice(goal.publishError);
  }, [goal.publishError]);

  const rememberCaret = (element: HTMLTextAreaElement) => {
    setCaret(element.selectionStart ?? element.value.length);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setText("");
    setCaret(0);
    actions.clearAttachments(session.id);
  };

  const stageBlobs = async (blobs: File[]) => {
    const images = blobs.filter((file) => file.type.startsWith("image/") || isImagePath(file.name));
    const rejected = blobs.length > images.length;
    if (rejected) setNotice("只能附加图片");
    if (images.length === 0) return;
    const staged = [];
    for (const file of images) staged.push(await stageChatImage(file));
    if (staged.length) {
      if (!rejected) setNotice(null);
      actions.addAttachments(session.id, staged);
    }
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
      void actions.setCollaborationMode(session.id, decision.mode);
      return;
    }
    setText(decision.text);
    textareaRef.current?.focus();
  };

  const applySkill = (skill: AgentSkillOption) => {
    const next = insertSkill(text, caret, skill.mention);
    setText(next);
    setCaret(next.length);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.length, next.length);
    });
  };

  const submit = () => {
    const attached = useWorkbench.getState().attachments[session.id] ?? [];
    const decision = decideSubmit({
      text,
      supportsPlan: Boolean(caps?.supports_plan),
      supportsReview: Boolean(caps?.supports_review),
      planOn: view.planOn,
      imagesOn: view.imagesOn,
      attached,
      editingId,
      pendingId: view.pendingId,
      composerLocked: view.composerLocked,
      goalDraft: goal.goalDraft,
      supportsGoals,
    });
    if (decision.type === "noop") return;
    if (decision.type === "set-goal") {
      void goal.submit(decision.text).then((ok) => {
        if (!ok) return;
        setText("");
        setCaret(0);
      });
      textareaRef.current?.focus();
      return;
    }
    if (decision.type === "toggle-plan") {
      setText("");
      void actions.setCollaborationMode(session.id, decision.mode);
      return;
    }
    if (decision.type === "plan-message") {
      setText("");
      void actions.setCollaborationMode(session.id, "plan").then(() => {
        void actions.sendMessage(session.id, decision.text);
      });
      return;
    }
    if (decision.type === "open-review") {
      setText("");
      setReviewOpen(true);
      return;
    }
    if (decision.type === "update-queue") {
      setEditingId(null);
      setText("");
      actions.clearAttachments(session.id);
      void updateQueuedTurn(session.id, decision.id, decision.text, decision.images);
      textareaRef.current?.focus();
      return;
    }
    if (decision.type === "answer") {
      setText("");
      void actions.answerPrompt(session.id, decision.promptId, { type: "single", value: decision.text });
      textareaRef.current?.focus();
      return;
    }
    setText("");
    if (decision.type === "send-images") {
      void actions.sendMessage(session.id, decision.text, decision.images);
      actions.clearAttachments(session.id);
    } else {
      void actions.sendMessage(session.id, decision.text, []);
      if (decision.clearAttachments) actions.clearAttachments(session.id);
    }
    textareaRef.current?.focus();
  };

  const pickFiles = async () => {
    if (view.composerLocked) return;
    setMenu(null);
    const picked = await pickAttachments(view.imagesOn);
    if (!picked.length) return;
    if (view.imagesOn) {
      const images = picked.filter((file) => isImagePath(file.path));
      if (images.length !== picked.length) setNotice("只能附加图片");
      if (images.length) {
        setNotice(images.length === picked.length ? null : "只能附加图片");
        actions.addAttachments(session.id, images);
      }
      return;
    }
    actions.addAttachments(session.id, picked);
  };

  const beginEdit = (item: { id: string; text: string; images?: string[] }) => {
    setEditingId(item.id);
    setText(item.text);
    setCaret(item.text.length);
    actions.replaceAttachments(
      session.id,
      (item.images ?? []).map((path) => ({ path, name: fileName(path) })),
    );
    requestAnimationFrame(() => textareaRef.current?.focus());
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
    rememberCaret,
    cancelEdit,
    stageBlobs,
    applySlash,
    applySkill,
    submit,
    pickFiles,
    beginEdit,
    applySandbox,
    removeQueued: (id: string) => {
      if (editingId === id) cancelEdit();
      void removeQueuedTurn(session.id, id);
    },
    interrupt: () => {
      void interruptTurn(session.id);
    },
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
    goalChip: goal.chip,
    dismissGoal: goal.dismiss,
    startReview: (target: ReviewStart) => {
      setReviewOpen(false);
      void actions.startReview(session.id, target);
    },
    addDir: () => {
      void pickWritableDirectory().then((path) => {
        if (!path) return;
        applySandbox(addWritableRoot(data.sandbox, path, data.projectPath));
      });
    },
    removeDir: (path: string) => applySandbox(removeWritableRoot(data.sandbox, path)),
    selectPreset: (mode: Parameters<typeof selectPreset>[1]) => applySandbox(selectPreset(data.sandbox, mode)),
    selectProfile: (id: string) => applySandbox(selectProfile(data.sandbox, id)),
    setNetwork: (enabled: boolean) => applySandbox(setNetwork(data.sandbox, enabled)),
    chooseModel: (model: AgentModelOption) => {
      actions.setTuning(session.id, model.id, effortForModel(model, view.selectedEffort));
      setMenu(null);
    },
    chooseEffort: (effort: string) => {
      if (!view.selectedModel) return;
      actions.setTuning(session.id, view.selectedModel.id, effort);
      setMenu(null);
    },
    removeFile: (path: string) => actions.removeAttachment(session.id, path),
    onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      const intent = composerKeyIntent({
        key: event.key,
        shiftKey: event.shiftKey,
        composing: event.nativeEvent.isComposing,
        editing: Boolean(editingId),
        skillOpen: view.skillOpen,
        hasActiveSkill: Boolean(activeSkill),
        slashOpen: view.slashOpen,
        hasActiveSlash: Boolean(activeSlash),
        token: view.token,
        activeSlashName: activeSlash?.name,
        text,
        skillQuery: view.skillQuery,
        activeSkillMention: activeSkill?.mention,
        mentionOpen: mentions.show,
        hasActiveMention: mentions.hasActive,
      });
      if (!intent) return;
      event.preventDefault();
      if (intent.type === "cancel-edit") cancelEdit();
      else if (intent.type === "dismiss-mention") mentions.dismiss();
      else if (intent.type === "mention-move") mentions.move(intent.key);
      else if (intent.type === "apply-mention") mentions.apply();
      else if (intent.type === "mention-noop") return;
      else if (intent.type === "skill-move") {
        setSkillIndex((current) => stepIndex(current, view.skillMatches.length, intent.key));
      } else if (intent.type === "slash-move") {
        setSlashIndex((current) => stepIndex(current, view.slashMatches.length, intent.key));
      } else if (intent.type === "apply-skill" && activeSkill) applySkill(activeSkill);
      else if (intent.type === "apply-slash" && activeSlash) applySlash(activeSlash);
      else if (intent.type === "submit") submit();
    },
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!view.imagesOn || view.composerLocked) return;
      const blobs = Array.from(event.clipboardData.files);
      if (!blobs.length) return;
      event.preventDefault();
      void stageBlobs(blobs);
    },
  };
}
