import { isDraftId, isPendingId } from "./draft-session.ts";

/** 挂上作曲栏时用哪一段文字。懒草稿走项目草稿，不读会话缓存。 */
export function composerTextOnMount(input: {
  sessionId: string;
  projectDraftText: string | undefined;
  parkedText: string | null;
  sessionDrafts: Readonly<Record<string, string>>;
}): string {
  if (isDraftId(input.sessionId)) return input.projectDraftText ?? "";
  if (input.parkedText !== null) return input.parkedText;
  return input.sessionDrafts[input.sessionId] ?? "";
}

/** 真实会话的未发送文字。空串删掉。懒草稿和占位 id 原样返回。 */
export function rememberSessionComposerDraft(
  drafts: Readonly<Record<string, string>>,
  sessionId: string,
  text: string,
): Record<string, string> {
  if (!keepsSessionDraft(sessionId)) return drafts as Record<string, string>;
  if (!text) {
    if (!(sessionId in drafts)) return drafts as Record<string, string>;
    const next = { ...drafts };
    delete next[sessionId];
    return next;
  }
  if (drafts[sessionId] === text) return drafts as Record<string, string>;
  return { ...drafts, [sessionId]: text };
}

/**
 * 发送成功才清这次的草稿。
 * 清的是发出前的原文或实际发出的正文。用户已经另打了一段时留下。
 */
export function composerDraftsAfterSend(
  drafts: Readonly<Record<string, string>>,
  sessionId: string,
  previousText: string,
  sentText: string,
  ok: boolean,
): Record<string, string> {
  if (!ok || !keepsSessionDraft(sessionId)) return drafts as Record<string, string>;
  const current = drafts[sessionId];
  if (current === undefined) return drafts as Record<string, string>;
  if (current !== previousText && current !== sentText) return drafts as Record<string, string>;
  const next = { ...drafts };
  delete next[sessionId];
  return next;
}

function keepsSessionDraft(sessionId: string): boolean {
  return Boolean(sessionId) && !isDraftId(sessionId) && !isPendingId(sessionId);
}
