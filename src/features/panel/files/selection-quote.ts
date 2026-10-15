/** 预览用正文，发送用围栏。两者分开，避免把围栏写进输入框。 */
export interface SelectionDraft {
  path: string;
  body: string;
  start: number | null;
  end: number | null;
  quote: string;
}

/** 选区和路径写成代码引用，跟发送时能看到的正文一致。 */
export function formatSelectionQuote(
  path: string,
  text: string,
  startLine: number | null,
  endLine: number | null,
): string {
  const file = path.trim();
  const body = text.replace(/\s+$/, "");
  if (!file || !body.trim()) return "";
  const span = lineSpan(startLine, endLine);
  const loc = span ? `${span.start}:${span.end}:` : "";
  return `\`\`\`${loc}${file}\n${body}\n\`\`\``;
}

export function selectionDraft(
  path: string,
  text: string,
  startLine: number | null,
  endLine: number | null,
): SelectionDraft | null {
  const quote = formatSelectionQuote(path, text, startLine, endLine);
  if (!quote) return null;
  const span = lineSpan(startLine, endLine);
  return {
    path: path.trim(),
    body: text.replace(/\s+$/, ""),
    start: span?.start ?? null,
    end: span?.end ?? null,
    quote,
  };
}

function lineSpan(startLine: number | null, endLine: number | null): { start: number; end: number } | null {
  const start = normalizeLine(startLine);
  const end = normalizeLine(endLine);
  if (start === null || end === null) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

export function lineRangeFromOffsets(source: string, start: number, end: number): { start: number; end: number } {
  const from = Math.max(0, Math.min(start, end, source.length));
  const to = Math.max(0, Math.min(Math.max(start, end), source.length));
  const startLine = source.slice(0, from).split("\n").length;
  const selected = source.slice(from, to);
  const extra = selected.length === 0 ? 0 : selected.split("\n").length - 1;
  return { start: startLine, end: startLine + extra };
}

function normalizeLine(line: number | null): number | null {
  if (line == null || !Number.isFinite(line) || line < 1) return null;
  return Math.floor(line);
}
