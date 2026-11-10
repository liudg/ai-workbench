import type { ClipboardEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

import { pickFiles } from "@/lib/native/pick-files";
import { stageImage } from "@/lib/native/stage-image";
import type { AgentCapabilities, AgentSkillOption, Attachment, SessionSandbox, SlashCommand } from "@/types";
import { composerKeyIntent, stepIndex } from "./composer-keys";
import { composerCtrlEnter, queueFlushIds, submitDelivery } from "./composer-now";
import { decideSlash, decideSubmit } from "./composer-submit";
import { expandFileRefs, type FileRef } from "./file-refs";
import {
  claimSubmit,
  settleSubmit,
  shouldClearSubmittedText,
  shouldRestoreFailedText,
  submitFingerprint,
  type SubmitFlight,
} from "./submit-flight";
import type { deriveComposerView } from "./composer-view";
import { fileName, isImagePath } from "./media";
import type { ComposerHost } from "./host";
import { insertSkill } from "./skills";

type View = ReturnType<typeof deriveComposerView>;

export interface ComposerRun {
  host: ComposerHost;
  /** 防重复提交按这个键记。一般是会话 id。 */
  flightKey: string;
  text: string;
  caret: number;
  /** 框里 `@文件名` 对应的完整路径。发送时换回去。 */
  fileRefs: FileRef[];
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
  caps: AgentCapabilities | undefined;
  view: View;
  goalDraft: boolean;
  exitGoal: () => void;
  /** 和 `@` 菜单「计划」「目标」同一个动作。 */
  togglePlan: () => void;
  enterGoal: () => void;
  supportsGoals: boolean;
  submitGoal: (text: string) => Promise<boolean>;
  mentions: {
    show: boolean;
    hasActive: boolean;
    dismiss: () => void;
    move: (key: "ArrowUp" | "ArrowDown") => void;
    apply: () => void;
  };
  /** 斜杠和技能菜单当前是否真的显示。按 Esc 收起后为 false，直到过滤词变化。 */
  slashShown: boolean;
  skillShown: boolean;
  dismissPopup: () => void;
  activeSlash: SlashCommand | undefined;
  activeSkill: AgentSkillOption | undefined;
  sandbox: SessionSandbox | null;
  skillMatches: number;
  slashMatches: number;
  submitFlight: { current: SubmitFlight | null };
  /** 草稿要等创建并发送成功后才清掉输入。失败时原文还在。 */
  holdUntilAccepted: boolean;
}

export function rememberCaret(setCaret: (value: number) => void, element: HTMLTextAreaElement) {
  setCaret(element.selectionStart ?? element.value.length);
}

export function cancelComposerEdit(run: ComposerRun) {
  run.setEditingId(null);
  run.setText("");
  run.setCaret(0);
  run.host.clearAttachments();
}

export async function stageComposerBlobs(run: ComposerRun, blobs: File[]) {
  const images = blobs.filter((file) => file.type.startsWith("image/") || isImagePath(file.name));
  const rejected = blobs.length > images.length;
  if (rejected) run.setNotice("只能附加图片");
  if (images.length === 0) return;
  const staged = [];
  try {
    for (const file of images) staged.push(await stageImage(file));
  } catch (error) {
    run.host.reportError(error);
  }
  if (staged.length) {
    if (!rejected) run.setNotice(null);
    run.host.addAttachments(staged);
  }
}

/** `execute`：不带参数的命令选中即执行，带参数的只补成「命令 」等用户写参数。 */
export function applyComposerSlash(run: ComposerRun, command: SlashCommand, execute = false) {
  const decision = decideSlash(command, run.caps);
  if (decision.type === "review") {
    run.setText("");
    run.setReviewOpen(true);
    return;
  }
  if (decision.type === "plan" || decision.type === "goal") {
    run.setText("");
    run.setCaret(0);
    if (decision.type === "plan") run.togglePlan();
    else run.enterGoal();
    run.textareaRef.current?.focus();
    return;
  }
  run.setText(decision.text);
  run.setCaret(decision.text.length);
  if (execute && !command.takes_args) {
    runComposerSubmit({ ...run, text: decision.text });
    return;
  }
  requestAnimationFrame(() => {
    run.textareaRef.current?.focus();
    run.textareaRef.current?.setSelectionRange(decision.text.length, decision.text.length);
  });
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

function clearIfUnchanged(run: ComposerRun) {
  const live = run.textareaRef.current?.value ?? null;
  if (!shouldClearSubmittedText(live, run.text)) return;
  run.setText("");
  run.setCaret(0);
}

export function runComposerSubmit(run: ComposerRun, options?: { now?: boolean }) {
  const now = Boolean(options?.now);
  const attached = run.host.files;
  const snippets = run.host.snippets;
  const fingerprint = submitFingerprint({
    editingId: run.editingId,
    text: run.text,
    fileCount: attached.length,
    snippetCount: snippets.length,
  });
  const decision = decideSubmit({
    text: expandFileRefs(run.text, run.fileRefs),
    supportsPlan: Boolean(run.caps?.supports_plan),
    supportsReview: Boolean(run.caps?.supports_review),
    planOn: run.view.planOn,
    imagesOn: run.view.imagesOn,
    attached,
    snippets,
    editingId: run.editingId,
    pendingId: run.view.pendingId,
    pendingKind: run.view.pendingKind,
    composerLocked: run.view.composerLocked,
    goalDraft: run.goalDraft,
    supportsGoals: run.supportsGoals,
  });
  if (decision.type === "noop") return;
  const deliverNow =
    submitDelivery({
      now,
      holdUntilAccepted: run.holdUntilAccepted,
      decision: decision.type,
    }) === "send-now";
  const claim = claimSubmit(run.submitFlight.current, { sessionId: run.flightKey, fingerprint });
  if (!claim.claimed) return;
  run.submitFlight.current = claim.flight;
  const release = () => {
    run.submitFlight.current = settleSubmit(run.submitFlight.current, run.flightKey, fingerprint);
  };
  const clearSnippets = "clearSnippets" in decision && Boolean(decision.clearSnippets);
  if (decision.type === "set-goal") {
    void run.submitGoal(decision.text).then((ok) => {
      if (!ok) {
        release();
        return;
      }
      clearIfUnchanged(run);
    });
    run.textareaRef.current?.focus();
    return;
  }
  if (decision.type === "toggle-plan" || decision.type === "enter-goal") {
    run.setText("");
    run.setCaret(0);
    if (decision.type === "toggle-plan") run.togglePlan();
    else run.enterGoal();
    return;
  }
  if (decision.type === "open-review") {
    run.setText("");
    run.setReviewOpen(true);
    return;
  }
  if (decision.type === "plan-message") {
    if (run.holdUntilAccepted) {
      void (async () => {
        try {
          await run.host.setCollaborationMode("plan");
          const ok = await run.host.send(decision.text, [], false);
          if (!ok) {
            release();
            run.textareaRef.current?.focus();
            return;
          }
          clearIfUnchanged(run);
          run.exitGoal();
          if (clearSnippets) run.host.clearTextSnippets();
        } catch {
          release();
        }
      })();
      return;
    }
    run.setText("");
    run.exitGoal();
    if (clearSnippets) run.host.clearTextSnippets();
    void run.host
      .setCollaborationMode("plan")
      .then(() => run.host.send(decision.text, [], deliverNow))
      .then((ok) => {
        if (ok) return;
        release();
        restoreFailedSend(run, []);
      });
    return;
  }
  if (decision.type === "update-queue") {
    const queuedId = decision.id;
    const queuedText = decision.text;
    const queuedImages = decision.images;
    run.setEditingId(null);
    run.setText("");
    run.host.clearAttachments();
    if (clearSnippets) run.host.clearTextSnippets();
    if (deliverNow) {
      void run.host.send(queuedText, queuedImages, true).then((ok) => {
        if (ok) void run.host.removeQueued(queuedId);
      });
    } else {
      void run.host.updateQueued(queuedId, queuedText, queuedImages);
    }
    run.textareaRef.current?.focus();
    return;
  }
  if (decision.type === "answer") {
    run.setText("");
    if (clearSnippets) run.host.clearTextSnippets();
    void run.host.answerPrompt(decision.promptId, { type: "single", value: decision.text });
    run.textareaRef.current?.focus();
    return;
  }
  const images = decision.type === "send-images" ? decision.images : [];
  const clearAttachments = decision.type === "send-images" || decision.clearAttachments;
  if (run.holdUntilAccepted) {
    void (async () => {
      try {
        const ok = await run.host.send(decision.text, images, false);
        if (!ok) {
          release();
          run.textareaRef.current?.focus();
          return;
        }
        clearIfUnchanged(run);
        if (clearAttachments) run.host.clearAttachments();
        if (clearSnippets) run.host.clearTextSnippets();
        run.textareaRef.current?.focus();
      } catch {
        release();
      }
    })();
    return;
  }
  run.setText("");
  if (clearSnippets) run.host.clearTextSnippets();
  void run.host.send(decision.text, images, deliverNow).then((ok) => {
    if (ok) return;
    release();
    restoreFailedSend(run, clearAttachments ? attached : []);
  });
  if (clearAttachments) run.host.clearAttachments();
  run.textareaRef.current?.focus();
}

function restoreFailedSend(run: ComposerRun, attached: Attachment[]) {
  if (!shouldRestoreFailedText(run.textareaRef.current?.value ?? null)) return;
  run.setText(run.text);
  run.setCaret(run.text.length);
  if (attached.length > 0) run.host.addAttachments(attached);
}

/** Ctrl+Enter。有内容直接送出；空输入则按队列顺序逐条引导。 */
export function runComposerCtrlEnter(run: ComposerRun) {
  const queue = run.host.queue;
  const action = composerCtrlEnter({
    text: run.text,
    fileCount: run.host.files.length,
    snippetCount: run.host.snippets.length,
    queueCount: queue.length,
    editing: Boolean(run.editingId),
    pendingQuestion: Boolean(run.view.pendingId) && run.view.pendingKind !== "approval",
    composerLocked: run.view.composerLocked,
  });
  if (action.type === "noop") return;
  if (action.type === "plain-submit") {
    runComposerSubmit(run);
    return;
  }
  if (action.type === "flush-queue") {
    void run.host.flushQueued(queueFlushIds(queue.map((item) => item.id)));
    return;
  }
  runComposerSubmit(run, { now: true });
}

export async function pickComposerFiles(run: ComposerRun) {
  if (run.view.composerLocked) return;
  run.setMenu(null);
  addComposerFiles(run, await pickFiles(run.view.imagesOn ? "选择图片和文件" : "选择文件"));
}

/** 选的或拖进来的本机文件。图片走图像通道，其它文件发送时把路径写进消息。 */
export function addComposerFiles(run: ComposerRun, files: Attachment[]) {
  if (run.view.composerLocked || !files.length) return;
  run.setNotice(null);
  run.host.addAttachments(files);
  run.textareaRef.current?.focus();
}

export function beginComposerEdit(
  run: ComposerRun,
  item: { id: string; text: string; images?: string[] },
) {
  run.setEditingId(item.id);
  run.setText(item.text);
  run.setCaret(item.text.length);
  run.host.replaceAttachments((item.images ?? []).map((path) => ({ path, name: fileName(path) })));
  requestAnimationFrame(() => run.textareaRef.current?.focus());
}

export function handleComposerKey(run: ComposerRun, event: ReactKeyboardEvent<HTMLTextAreaElement>) {
  const intent = composerKeyIntent({
    key: event.key,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    repeat: event.repeat,
    composing: event.nativeEvent.isComposing,
    keyCode: event.nativeEvent.keyCode,
    editing: Boolean(run.editingId),
    skillOpen: run.skillShown,
    hasActiveSkill: Boolean(run.activeSkill),
    slashOpen: run.slashShown,
    hasActiveSlash: Boolean(run.activeSlash),
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
  else if (intent.type === "dismiss-popup") run.dismissPopup();
  else if (intent.type === "skill-move") {
    run.setSkillIndex((current) => stepIndex(current, run.skillMatches, intent.key));
  } else if (intent.type === "slash-move") {
    run.setSlashIndex((current) => stepIndex(current, run.slashMatches, intent.key));
  } else if (intent.type === "apply-skill" && run.activeSkill) applyComposerSkill(run, run.activeSkill);
  else if (intent.type === "apply-slash" && run.activeSlash) applyComposerSlash(run, run.activeSlash, intent.run);
  else if (intent.type === "submit") runComposerSubmit(run);
  else if (intent.type === "submit-now") runComposerCtrlEnter(run);
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
  void run.host.removeQueued(id);
}

export function steerComposerQueued(run: ComposerRun, id: string) {
  if (run.editingId === id) cancelComposerEdit(run);
  void run.host.steerQueued(id);
}
