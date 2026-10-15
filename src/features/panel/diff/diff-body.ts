import { diffLine, expandDiffLines, foldDiffLines, type DiffFoldRow } from "./fold.ts";

/** 去掉只改空白的增删行。文件仍留在列表里，统计也不改。 */
export function withoutWhitespaceChanges(diff: string): string {
  const lines = diff.split(/\r?\n/);
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.startsWith("@@")) {
      out.push(line);
      index += 1;
      continue;
    }
    index += 1;
    const body: string[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.startsWith("@@") || next.startsWith("diff --git ")) break;
      body.push(next);
      index += 1;
    }
    const filtered = filterWhitespaceHunk(body);
    if (filtered.some((row) => row.startsWith("+") || row.startsWith("-"))) {
      out.push(line, ...filtered);
    }
  }
  return out.join("\n");
}

function filterWhitespaceHunk(body: string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < body.length) {
    const line = body[index] ?? "";
    if (!line.startsWith("-") && !line.startsWith("+")) {
      out.push(line);
      index += 1;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    const notes: string[] = [];
    while (index < body.length && ((body[index] ?? "").startsWith("-") || (body[index] ?? "").startsWith("\\"))) {
      const row = body[index] ?? "";
      if (row.startsWith("\\")) notes.push(row);
      else removed.push(row.slice(1));
      index += 1;
    }
    while (index < body.length && ((body[index] ?? "").startsWith("+") || (body[index] ?? "").startsWith("\\"))) {
      const row = body[index] ?? "";
      if (row.startsWith("\\")) notes.push(row);
      else added.push(row.slice(1));
      index += 1;
    }
    if (collapseSpace(removed.join("\n")) === collapseSpace(added.join("\n"))) continue;
    for (const row of removed) out.push(`-${row}`);
    for (const row of added) out.push(`+${row}`);
    out.push(...notes);
  }
  return out;
}

const IMPORT_LINE = /^(?:import\s|using\s|from\s+\S+\s+import\b|#include\s)/;

/** 「隐藏导入内容」只拿掉 import / using 行，文件头和其余差异留着。 */
export function withoutImportLines(diff: string): string {
  return diff
    .split(/\r?\n/)
    .filter((line) => {
      if (
        !line ||
        line.startsWith("diff ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("@@") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file") ||
        line.startsWith("\\")
      ) {
        return true;
      }
      const body = line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") ? line.slice(1).trim() : line.trim();
      return !IMPORT_LINE.test(body);
    })
    .join("\n");
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
  const original = input.hideImports ? withoutImportLines(input.diff) : input.diff;
  const filtered = input.hideWhitespace ? withoutWhitespaceChanges(original) : original;
  const folded = foldDiffLines(filtered);
  const originalChanges = hasEdits(foldDiffLines(original));
  if (folded.some((row) => row.kind === "line")) {
    if (!hasEdits(folded) && originalChanges && input.hideWhitespace) {
      return { rows: [], whitespaceHidden: true };
    }
    if (input.loadFull && input.source != null && isUnifiedDiff(filtered)) {
      return { rows: expandDiffLines(filtered, input.source), whitespaceHidden: false };
    }
    return { rows: folded, whitespaceHidden: false };
  }
  if (input.hideWhitespace && originalChanges) {
    return { rows: [], whitespaceHidden: true };
  }
  if (!isUnifiedDiff(original)) {
    const tone = rawTone(input.status, input.added, input.removed);
    if (tone) {
      return {
        rows: contentLines(original).map((text, index) =>
          diffLine(tone, text, tone === "del" ? index + 1 : null, tone === "add" ? index + 1 : null),
        ),
        whitespaceHidden: false,
      };
    }
  }
  return { rows: [], whitespaceHidden: false };
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
