import { diffLine, expandDiffLines, foldDiffLines, type DiffFoldRow } from "./fold.ts";

type LineRow = Extract<DiffFoldRow, { kind: "line" }>;

/**
 * 去掉只改空白的增删行。在已经编好行号的行上做，不改 diff 文本，行号不会错位。
 * 一行对一行：两边去掉空白后相同，才丢掉这一对。不能把整段增删拼起来比，否则拆行会把整个文件当成空白改动。
 */
function withoutWhitespaceRows(rows: DiffFoldRow[]): DiffFoldRow[] {
  const out: DiffFoldRow[] = [];
  let index = 0;
  while (index < rows.length) {
    if (!isEdit(rows[index])) {
      out.push(rows[index]);
      index += 1;
      continue;
    }
    const run: DiffFoldRow[] = [];
    while (index < rows.length && (isEdit(rows[index]) || isMeta(rows[index]))) {
      run.push(rows[index]);
      index += 1;
    }
    out.push(...pairWhitespaceRows(run));
  }
  return out;
}

function pairWhitespaceRows(run: DiffFoldRow[]): DiffFoldRow[] {
  const dropped = new Set<DiffFoldRow>();
  const added = run.filter((row): row is LineRow => row.kind === "line" && row.tone === "add");
  for (const row of run) {
    if (row.kind !== "line" || row.tone !== "del") continue;
    const collapsed = collapseSpace(row.text);
    const match = added.find((item) => !dropped.has(item) && collapseSpace(item.text) === collapsed);
    if (match) {
      dropped.add(match);
      dropped.add(row);
    }
  }
  return run.filter((row) => {
    if (dropped.has(row)) return false;
    return !(isEdit(row) && row.kind === "line" && collapseSpace(row.text).length === 0);
  });
}

const IMPORT_LINE = /^(?:import\s|using\s|from\s+\S+\s+import\b|#include\s)/;

/** 「隐藏导入内容」只拿掉 import / using 行，其余行和行号照旧。 */
function withoutImportRows(rows: DiffFoldRow[]): DiffFoldRow[] {
  return rows.filter((row) => row.kind !== "line" || row.tone === "meta" || !IMPORT_LINE.test(row.text.trim()));
}

function isEdit(row: DiffFoldRow | undefined): boolean {
  return row?.kind === "line" && (row.tone === "add" || row.tone === "del");
}

function isMeta(row: DiffFoldRow | undefined): boolean {
  return row?.kind === "line" && row.tone === "meta";
}

function collapseSpace(text: string): string {
  return text.replace(/\s+/g, "");
}

export interface DiffBody {
  rows: DiffFoldRow[];
  /** 这份 diff 只剩空白改动，文件仍应留在列表里。 */
  whitespaceHidden: boolean;
}

/**
 * 展开后的差异正文。统一 diff 走 hunk；新增/删除文件的正文按 Codex
 * `diff_render` 整段画成绿行或红行。隐藏空白只改渲染，不决定文件在不在。
 */
export function diffBodyRows(input: {
  diff: string;
  status: string;
  added: number;
  removed: number;
  source: string | null;
  loadFull: boolean;
  hideWhitespace: boolean;
  hideImports: boolean;
}): DiffBody {
  const filter = (rows: DiffFoldRow[]) => {
    const kept = input.hideImports ? withoutImportRows(rows) : rows;
    return input.hideWhitespace ? withoutWhitespaceRows(kept) : kept;
  };
  const folded = foldDiffLines(input.diff);
  if (hasVisibleRows(folded)) {
    const expanded =
      input.loadFull && input.source != null ? expandDiffLines(input.diff, input.source) : null;
    const rows = filter(expanded ?? folded);
    const before = input.hideImports ? withoutImportRows(folded) : folded;
    if (input.hideWhitespace && hasEdits(before) && !hasEdits(rows)) {
      return { rows: [], whitespaceHidden: true };
    }
    return { rows, whitespaceHidden: false };
  }
  const tone = rawTone(input.status, input.added, input.removed);
  if (tone) {
    const rows = rawBodyLines(input.diff, tone).map((text, index) =>
      diffLine(tone, text, tone === "del" ? index + 1 : null, tone === "add" ? index + 1 : null),
    );
    const kept = input.hideImports ? withoutImportRows(rows) : rows;
    if (kept.length > 0) return { rows: kept, whitespaceHidden: false };
  }
  return { rows: [], whitespaceHidden: false };
}

function hasVisibleRows(rows: DiffFoldRow[]): boolean {
  return rows.some((row) => row.kind === "line" && row.tone !== "meta");
}

/** 统一 diff 没形成 hunk 时，仍把新增行或删除行画出来。裸正文则整段上色。 */
function rawBodyLines(diff: string, tone: "add" | "del"): string[] {
  if (!isUnifiedDiff(diff)) return contentLines(diff);
  const mark = tone === "add" ? "+" : "-";
  const header = tone === "add" ? "+++" : "---";
  const lines: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith(header)) continue;
    if (line.startsWith(mark)) lines.push(line.slice(1));
  }
  return lines;
}

function hasEdits(rows: DiffFoldRow[]): boolean {
  return rows.some((row) => row.kind === "line" && (row.tone === "add" || row.tone === "del"));
}

function isUnifiedDiff(diff: string): boolean {
  return diff.split(/\r?\n/).some((line) => line.startsWith("@@") || line.startsWith("diff --git "));
}

/** 跟 Rust `str::lines`：末尾换行不再多算一行。 */
function contentLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function rawTone(status: string, added: number, removed: number): "add" | "del" | null {
  switch (status.trim().toLowerCase()) {
    case "a":
    case "add":
    case "added":
      return "add";
    case "d":
    case "delete":
    case "deleted":
      return "del";
    default:
      if (added > 0 && removed === 0) return "add";
      if (removed > 0 && added === 0) return "del";
      return null;
  }
}
