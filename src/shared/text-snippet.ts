import { DESKTOP_ZH } from "./strings/desktop-zh.ts";

/** 选区在发送前的形状。围栏留到真正发出去再拼。 */
export interface TextSnippetDraft {
  path: string;
  body: string;
  start: number | null;
  end: number | null;
  quote: string;
}

/** 会话上的一条已选文本。和文件附件分开，不进输入框。 */
export interface TextSnippet {
  id: string;
  path: string;
  start: number | null;
  end: number | null;
  body: string;
  quote: string;
}

const PREVIEW_LINES = 4;
const PREVIEW_CHARS = 180;

let serial = 0;

export function createTextSnippet(draft: TextSnippetDraft, id?: string): TextSnippet | null {
  const path = draft.path.trim();
  const quote = draft.quote.trim();
  const body = draft.body.replace(/\s+$/, "");
  if (!path || !quote || !body.trim()) return null;
  const span = lineSpan(draft.start, draft.end);
  const nextId = id?.trim() || `text-snippet-${++serial}`;
  if (!nextId) return null;
  return {
    id: nextId,
    path,
    start: span?.start ?? null,
    end: span?.end ?? null,
    body,
    quote,
  };
}

export function withTextSnippet(list: readonly TextSnippet[], snippet: TextSnippet): TextSnippet[] {
  if (!snippet.id.trim() || !snippet.quote.trim() || !snippet.body.trim()) return list as TextSnippet[];
  if (list.some((item) => item.id === snippet.id)) return list as TextSnippet[];
  return [...list, snippet];
}

export function withoutTextSnippet(list: readonly TextSnippet[], id: string): TextSnippet[] {
  if (!list.some((item) => item.id === id)) return list as TextSnippet[];
  return list.filter((item) => item.id !== id);
}

/** 用户自己的字在前，选区围栏按添加顺序接在后面。没有选区时原文不动。 */
export function mergeSnippetText(userText: string, snippets: readonly { quote: string }[]): string {
  const quotes = snippets.map((item) => item.quote.trim()).filter(Boolean);
  if (quotes.length === 0) return userText;
  const head = userText.trim();
  const tail = quotes.join("\n\n");
  return head ? `${head}\n\n${tail}` : tail;
}

export function textSnippetChipLabel(count: number): string {
  return DESKTOP_ZH.textSnippetChip.replace("{count}", String(count));
}

/** 预览只露正文前几行，发送仍用完整围栏。 */
export function textSnippetPreview(body: string): string {
  const text = body.replace(/\s+$/, "");
  const lines = text.split("\n");
  const lineCut = lines.length > PREVIEW_LINES;
  let preview = lineCut ? lines.slice(0, PREVIEW_LINES).join("\n") : text;
  const charCut = preview.length > PREVIEW_CHARS;
  if (charCut) preview = preview.slice(0, PREVIEW_CHARS);
  preview = preview.replace(/\s+$/, "");
  return lineCut || charCut ? `${preview}...` : preview;
}

function lineSpan(startLine: number | null, endLine: number | null): { start: number; end: number } | null {
  const start = normalizeLine(startLine);
  const end = normalizeLine(endLine);
  if (start === null || end === null) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function normalizeLine(line: number | null): number | null {
  if (line == null || !Number.isFinite(line) || line < 1) return null;
  return Math.floor(line);
}
