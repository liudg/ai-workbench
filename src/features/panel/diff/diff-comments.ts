import type { TextSnippetDraft } from "../../../shared/text-snippet.ts";
import { selectionDraft } from "../viewers/selection-quote.ts";

/** 差异里能评论的一行：统一视图的一行，或并排视图某一栏的一格。 */
export interface DiffCommentLine {
  tone: "add" | "del" | "context" | "meta" | "pad";
  text: string;
  lineNo: number | null;
}

/** 统一视图一份文件一栏；并排视图左右各一栏。 */
export function diffCommentScope(path: string, lane: "unified" | "left" | "right"): string {
  return `${lane}:${path}`;
}

export function canCommentLine(line: DiffCommentLine | null | undefined): line is DiffCommentLine {
  return Boolean(line && line.tone !== "pad" && line.tone !== "meta");
}

/**
 * 选中的几行连同 +/- 写进引用，Agent 能看出是新增还是删除。
 * 行号用现在文件里的号：有未删除的行就只看它们；全是删除行时才用旧文件的号。
 */
export function diffSpanDraft(
  lines: readonly (DiffCommentLine | null)[],
  start: number,
  end: number,
  path: string,
): TextSnippetDraft | null {
  const picked = lines.slice(start, end + 1).filter(canCommentLine);
  if (picked.length === 0) return null;
  const body = picked.map((line) => `${sign(line.tone)}${line.text}`).join("\n");
  const kept = picked.filter((line) => line.tone !== "del");
  const numbers = (kept.length > 0 ? kept : picked)
    .map((line) => line.lineNo)
    .filter((no): no is number => no != null);
  return selectionDraft(path, body, numbers[0] ?? null, numbers[numbers.length - 1] ?? null);
}

function sign(tone: DiffCommentLine["tone"]): string {
  if (tone === "add") return "+";
  if (tone === "del") return "-";
  return " ";
}
