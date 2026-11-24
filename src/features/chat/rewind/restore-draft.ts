import type { Attachment, SessionEvent } from "../../../types/index.ts";

export interface RewoundDraftPayload {
  text: string;
  files: Attachment[];
}

function fileBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function toAttachment(path: string): Attachment {
  return { path, name: fileBaseName(path) };
}

const INLINE_ATTACHMENTS_RE = /\r?\n\r?\n附件：([^\r\n]+)$/;

/**
 * 把回退返回的用户消息原文与图片列表拆回作曲栏草稿：
 * - 还原 `composer-submit.ts` 追加的 `\n\n附件：a、b` 为 `Attachment[]`
 * - 合并 `restoredImages` 并按 `path` 去重
 */
export function parseRewoundDraft(
  restoredText: string,
  restoredImages: readonly string[] = [],
): RewoundDraftPayload {
  let text = restoredText;
  const extractedPaths: string[] = [];

  const inlineMatch = INLINE_ATTACHMENTS_RE.exec(text);
  if (inlineMatch) {
    const rawInline = (inlineMatch[1] ?? "").trim();
    const rawParts = /[\\/]/.test(rawInline)
      ? rawInline.split(/、(?=\s*(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/]))/)
      : rawInline.split("、");
    const items = rawParts
      .map((item) => item.trim())
      .filter(Boolean);
    if (items.length > 0) {
      extractedPaths.push(...items);
      text = text.slice(0, inlineMatch.index);
    }
  }

  const seen = new Set<string>();
  const files: Attachment[] = [];
  for (const raw of [...restoredImages, ...extractedPaths]) {
    const cleaned = raw.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    files.push(toAttachment(cleaned));
  }

  return { text, files };
}

/**
 * 判断某条时间线消息是否展示「回退到此处」入口（能力驱动，禁止硬编码比较 Agent 名称）。
 */
export function canRewindUserEvent(input: {
  hasHostRewind: boolean;
  event: SessionEvent;
  supportsConversationRewind: boolean | undefined;
}): boolean {
  if (!input.hasHostRewind) return false;
  if (!input.supportsConversationRewind) return false;
  if (input.event.kind !== "user-message") return false;
  if (input.event.sender != null) return false;
  if (input.event.text.trim() === "/goal") return false;
  return true;
}
