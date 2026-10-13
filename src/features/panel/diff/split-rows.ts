import type { DiffDisplayRow, WordPart } from "./word-diff.ts";

/** 宽于这个宽度时，自动布局改用并排。再窄就保持单列。 */
export const DIFF_AUTO_SPLIT_MIN_PX = 1080;

export type DiffLayoutMode = "auto" | "split";
export type DiffPresentation = "inline" | "split";

export function diffPresentation(layout: DiffLayoutMode, contentWidth: number): DiffPresentation {
  if (layout === "split") return "split";
  if (contentWidth >= DIFF_AUTO_SPLIT_MIN_PX) return "split";
  return "inline";
}

export interface SplitCell {
  tone: "add" | "del" | "context" | "meta" | "pad";
  text: string;
  lineNo: number | null;
  parts: WordPart[] | null;
}

export type SplitRow =
  | { kind: "collapse"; count: number }
  | { kind: "pair"; left: SplitCell; right: SplitCell };

const pad = (): SplitCell => ({ tone: "pad", text: "", lineNo: null, parts: null });

function isTone(row: DiffDisplayRow | undefined, tone: "add" | "del"): row is DiffDisplayRow & { kind: "line" } {
  return row?.kind === "line" && row.tone === tone;
}

function cellOf(row: DiffDisplayRow & { kind: "line" }, tone: SplitCell["tone"]): SplitCell {
  return { tone, text: row.text, lineNo: row.lineNo, parts: row.parts };
}

/** 单列差异排成左右两栏：删除在左，新增在右，上下文两边对齐。 */
export function toSplitRows(rows: readonly DiffDisplayRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (!row) break;
    if (row.kind === "collapse") {
      out.push(row);
      index += 1;
      continue;
    }
    if (row.tone === "meta") {
      out.push({ kind: "pair", left: cellOf(row, "meta"), right: pad() });
      index += 1;
      continue;
    }
    if (row.tone === "del") {
      const removed: Array<DiffDisplayRow & { kind: "line" }> = [];
      while (isTone(rows[index], "del")) {
        const line = rows[index];
        if (line?.kind === "line") removed.push(line);
        index += 1;
      }
      const added: Array<DiffDisplayRow & { kind: "line" }> = [];
      while (isTone(rows[index], "add")) {
        const line = rows[index];
        if (line?.kind === "line") added.push(line);
        index += 1;
      }
      const count = Math.max(removed.length, added.length);
      for (let cursor = 0; cursor < count; cursor += 1) {
        const left = removed[cursor];
        const right = added[cursor];
        out.push({
          kind: "pair",
          left: left ? cellOf(left, "del") : pad(),
          right: right ? cellOf(right, "add") : pad(),
        });
      }
      continue;
    }
    if (row.tone === "add") {
      out.push({ kind: "pair", left: pad(), right: cellOf(row, "add") });
      index += 1;
      continue;
    }
    out.push({
      kind: "pair",
      left: cellOf(row, "context"),
      right: cellOf(row, "context"),
    });
    index += 1;
  }
  return out;
}
