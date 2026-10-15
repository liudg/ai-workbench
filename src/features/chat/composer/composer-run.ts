import type { ClipboardEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

import { useWorkbench } from "@/store";
import type { AgentCapabilities, AgentSkillOption, SessionSandbox, SlashCommand } from "@/types";
import {
  interruptTurn,
  pickAttachments,
  removeQueuedTurn,
  stageChatImage,
  updateQueuedTurn,
} from "./composer-backend";
import { composerKeyIntent, stepIndex } from "./composer-keys";
import { decideSlash, decideSubmit } from "./composer-submit";
import type { deriveComposerView } from "./composer-view";
import { fileName, isImagePath } from "./media";
import { insertSkill } from "./skills";
import type { useComposerActions } from "./useComposerStore";

type Actions = ReturnType<typeof useComposerActions>;
type View = ReturnType<typeof deriveComposerView>;

export interface ComposerRun {
  sessionId: string;
  text: string;
  caret: number;
  editingId: string | null;
  setText: (value: string) => void;
  setCaret: (value: number) => void;
  setEditingId: (value: string | null) => void;
  setNotice: (value: string | null) => void;
  setMenu: (value: null | "access" | "model" | "attach") => void;
  setReviewOpen: (value: boolean) => void;
  setSlashIndex: (value: number | ((current: number) => number)) => void;
  setSkillIndex: (value: number | ((current: number) => number)) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  actions: Actions;
  caps: AgentCapabilities | undefined;
  view: View;
  goalDraft: boolean;
  exitGoal: () => void;
  supportsGoals: boolean;
  submitGoal: (text: string) => Promise<boolean>;
  mentions: {
    show: boolean;
    hasActive: boolean;
    dismiss: () => void;
    move: (key: "ArrowUp" | "ArrowDown") => void;
    apply: () => void;
  };
  activeSlash: SlashCommand | undefined;
  activeSkill: AgentSkillOption | undefined;
  sandbox: SessionSandbox | null;
  projectPath: string;
  skillMatches: number;
  slashMatches: number;
}

export function rememberCaret(setCaret: (value: number) => void, element: HTMLTextAreaElement) {
  setCaret(element.selectionStart ?? element.value.length);
}

export function cancelComposerEdit(run: ComposerRun) {
  run.setEditingId(null);
  run.setText("");
  run.setCaret(0);
  run.actions.clearAttachments(run.sessionId);
}

export async function stageComposerBlobs(run: ComposerRun, blobs: File[]) {
  const images = blobs.filter((file) => file.type.startsWith("image/") || isImagePath(file.name));
  const rejected = blobs.length > images.length;
  if (rejected) run.setNotice("只能附加图片");
  if (images.length === 0) return;
  const staged = [];
  for (const file of images) staged.push(await stageChatImage(file));
  if (staged.length) {
    if (!rejected) run.setNotice(null);
    run.actions.addAttachments(run.sessionId, staged);
  }
}

export function applyComposerSlash(run: ComposerRun, command: SlashCommand) {
  const decision = decideSlash(command, run.caps, run.view.planOn);
  if (decision.type === "review") {
    run.setText("");
    run.setReviewOpen(true);
    return;
  }
  if (decision.type === "toggle-plan") {
    run.setText("");
    if (decision.mode === "plan") run.exitGoal();
    void run.actions.setCollaborationMode(run.sessionId, decision.mode);
    return;
  }
  run.setText(decision.text);
  run.textareaRef.current?.focus();
}

export function applyComposerSkill(run: ComposerRun, skill: AgentSkillOption) {
  const next = insertSkill(run.text, run.caret, skill.mention);
  run.setText(next);
  run.setCaret(next.length);
  requestAnimationFrame(() => {
    run.textareaRef.current?.focus();
    run.textareaRef.current?.setSelectionRange(next.length, next.length);
  });
}

export function runComposerSubmit(run: ComposerRun) {
  const state = useWorkbench.getState();
  const attached = state.attachments[run.sessionId] ?? [];
  const snippets = state.textSnippets[run.sessionId] ?? [];
  const decision = decideSubmit({
    text: run.text,
    supportsPlan: Boolean(run.caps?.supports_plan),
    supportsReview: Boolean(run.caps?.supports_review),
    planOn: run.view.planOn,
    imagesOn: run.view.imagesOn,
    attached,
    snippets,
    editingId: run.editingId,
    pendingId: run.view.pendingId,
    composerLocked: run.view.composerLocked,
    goalDraft: run.goalDraft,
    supportsGoals: run.supportsGoals,
  });
  if (decision.type === "noop") return;
  if (decision.type === "set-goal") {
    void run.submitGoal(decision.text).then((ok) => {
      if (!ok) return;
      run.setText("");
      run.setCaret(0);
    });
    run.textareaRef.current?.focus();
    return;
  }
  if (decision.type === "toggle-plan") {
    run.setText("");
    if (decision.mode === "plan") run.exitGoal();
    void run.actions.setCollaborationMode(run.sessionId, decision.mode);
    return;
  }
  if (decision.type === "open-review") {
    run.setText("");
    run.setReviewOpen(true);
    return;
  }
  if ("clearSnippets" in decision && decision.clearSnippets) {
    run.actions.clearTextSnippets(run.sessionId);
  }
  if (decision.type === "plan-message") {
    run.setText("");
    run.exitGoal();
    void run.actions.setCollaborationMode(run.sessionId, "plan").then(() => {
      void run.actions.sendMessage(run.sessionId, decision.text);
    });
    return;
  }
  if (decision.type === "update-queue") {
    run.setEditingId(null);
    run.setText("");
    run.actions.clearAttachments(run.sessionId);
    void updateQueuedTurn(run.sessionId, decision.id, decision.text, decision.images);
    run.textareaRef.current?.focus();
    return;
  }
  if (decision.type === "answer") {
    run.setText("");
    void run.actions.answerPrompt(run.sessionId, decision.promptId, { type: "single", value: decision.text });
    run.textareaRef.current?.focus();
    return;
  }
  run.setText("");
  if (decision.type === "send-images") {
    void run.actions.sendMessage(run.sessionId, decision.text, decision.images);
    run.actions.clearAttachments(run.sessionId);
  } else {
    void run.actions.sendMessage(run.sessionId, decision.text, []);
    if (decision.clearAttachments) run.actions.clearAttachments(run.sessionId);
  }
  run.textareaRef.current?.focus();
}

export async function pickComposerFiles(run: ComposerRun) {
  if (run.view.composerLocked) return;
  run.setMenu(null);
  const picked = await pickAttachments(run.view.imagesOn);
  if (!picked.length) return;
  if (run.view.imagesOn) {
    const images = picked.filter((file) => isImagePath(file.path));
    if (images.length !== picked.length) run.setNotice("只能附加图片");
    if (images.length) {
      run.setNotice(images.length === picked.length ? null : "只能附加图片");
      run.actions.addAttachments(run.sessionId, images);
    }
    return;
  }
  run.actions.addAttachments(run.sessionId, picked);
}

export function beginComposerEdit(
  run: ComposerRun,
  item: { id: string; text: string; images?: string[] },
) {
  run.setEditingId(item.id);
  run.setText(item.text);
  run.setCaret(item.text.length);
  run.actions.replaceAttachments(
    run.sessionId,
    (item.images ?? []).map((path) => ({ path, name: fileName(path) })),
  );
  requestAnimationFrame(() => run.textareaRef.current?.focus());
}

export function handleComposerKey(run: ComposerRun, event: ReactKeyboardEvent<HTMLTextAreaElement>) {
  const intent = composerKeyIntent({
    key: event.key,
    shiftKey: event.shiftKey,
    composing: event.nativeEvent.isComposing,
    editing: Boolean(run.editingId),
    skillOpen: run.view.skillOpen,
    hasActiveSkill: Boolean(run.activeSkill),
    slashOpen: run.view.slashOpen,
    hasActiveSlash: Boolean(run.activeSlash),
    token: run.view.token,
    activeSlashName: run.activeSlash?.name,
    text: run.text,
    skillQuery: run.view.skillQuery,
    activeSkillMention: run.activeSkill?.mention,
    mentionOpen: run.mentions.show,
    hasActiveMention: run.mentions.hasActive,
  });
  if (!intent) return;
  event.preventDefault();
  if (intent.type === "cancel-edit") cancelComposerEdit(run);
  else if (intent.type === "dismiss-mention") run.mentions.dismiss();
  else if (intent.type === "mention-move") run.mentions.move(intent.key);
  else if (intent.type === "apply-mention") run.mentions.apply();
  else if (intent.type === "mention-noop") return;
  else if (intent.type === "skill-move") {
    run.setSkillIndex((current) => stepIndex(current, run.skillMatches, intent.key));
  } else if (intent.type === "slash-move") {
    run.setSlashIndex((current) => stepIndex(current, run.slashMatches, intent.key));
  } else if (intent.type === "apply-skill" && run.activeSkill) applyComposerSkill(run, run.activeSkill);
  else if (intent.type === "apply-slash" && run.activeSlash) applyComposerSlash(run, run.activeSlash);
  else if (intent.type === "submit") runComposerSubmit(run);
}

export function pasteComposerImages(run: ComposerRun, event: ClipboardEvent<HTMLTextAreaElement>) {
  if (!run.view.imagesOn || run.view.composerLocked) return;
  const blobs = Array.from(event.clipboardData.files);
  if (!blobs.length) return;
  event.preventDefault();
  void stageComposerBlobs(run, blobs);
}

export function removeComposerQueued(run: ComposerRun, id: string) {
  if (run.editingId === id) cancelComposerEdit(run);
  void removeQueuedTurn(run.sessionId, id);
}

export function interruptComposer(run: ComposerRun) {
  void interruptTurn(run.sessionId);
}
