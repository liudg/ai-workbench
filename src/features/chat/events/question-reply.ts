/**
 * 答后历史里的展示文案。
 * 单题是 `> 问题`、空行、答案；多题用空行接在一起。
 * 未转换成展示文案时，正文是 `send_user_message_question_reply` 信封。
 */

export interface QuestionReplyRow {
  question: string;
  answer: string;
}

const ENVELOPE_OPEN = "<send_user_message_question_reply>";
const ENVELOPE_CLOSE = "</send_user_message_question_reply>";
const IDE_PREAMBLE = "# Context from my IDE setup:\n";
const IDE_REQUEST = "\n## My request for Codex:\n";

/** 三题及以上默认收起，避免时间线被题答行撑开。 */
export function questionReplyStartsCollapsed(count: number): boolean {
  return count >= 3;
}

export function questionReplyTitle(count: number): string {
  return `已回答 ${count} 题`;
}

export function parseQuestionReply(text: string): QuestionReplyRow[] | null {
  const stripped = stripIdePreamble(text);
  if (stripped == null) return null;
  const source = stripped.replace(/\r\n/g, "\n").trim();
  if (!source) return null;
  const enveloped = parseEnvelopeMessage(source);
  if (enveloped) return enveloped;
  return parseDisplayMessage(source);
}

function stripIdePreamble(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(IDE_PREAMBLE)) return trimmed;
  const at = trimmed.lastIndexOf(IDE_REQUEST);
  if (at < 0) return null;
  return trimmed.slice(at + IDE_REQUEST.length);
}

function parseEnvelopeMessage(text: string): QuestionReplyRow[] | null {
  if (!text.includes(ENVELOPE_OPEN)) return null;
  const pattern = new RegExp(
    `${escapeRegExp(ENVELOPE_OPEN)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(ENVELOPE_CLOSE)}`,
    "g",
  );
  const rows: QuestionReplyRow[] = [];
  let cursor = 0;
  let found = false;
  for (const match of text.matchAll(pattern)) {
    found = true;
    const index = match.index ?? 0;
    if (text.slice(cursor, index).trim()) return null;
    const parsed = parseReplyJson(match[1] ?? "");
    if (!parsed) return null;
    rows.push(...parsed);
    cursor = index + match[0].length;
  }
  if (!found || text.slice(cursor).trim() || rows.length === 0) return null;
  return rows;
}

function parseReplyJson(body: string): QuestionReplyRow[] | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) return null;
  const rows: QuestionReplyRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (typeof record.question !== "string" || typeof record.answer !== "string") return null;
    const question = record.question.trim();
    const answer = record.answer.trim();
    if (!question || !answer) return null;
    rows.push({ question, answer });
  }
  return rows;
}

function parseDisplayMessage(text: string): QuestionReplyRow[] | null {
  if (!text.startsWith("> ")) return null;
  const parts = text.split(/\n\n(?=> )/);
  const rows: QuestionReplyRow[] = [];
  for (const part of parts) {
    const matched = /^> ([^\n]+)\n\n([\s\S]+)$/.exec(part);
    if (!matched) return null;
    const question = matched[1].trim();
    const answer = matched[2].trim();
    if (!question || !answer) return null;
    rows.push({ question, answer });
  }
  return rows.length > 0 ? rows : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
