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
  const start = normalizeLine(startLine);
  const end = normalizeLine(endLine);
  const loc = start && end ? `${Math.min(start, end)}:${Math.max(start, end)}:` : "";
  return `\`\`\`${loc}${file}\n${body}\n\`\`\``;
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
