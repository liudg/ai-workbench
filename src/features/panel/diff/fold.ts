import { sourceLines } from "../core/source-lines.ts";

export function unmodifiedLinesLabel(count: number): string {
  return `${count} unmodified lines`;
}

export type DiffFoldRow =
  | { kind: "collapse"; count: number }
  | {
      kind: "line";
      tone: "add" | "del" | "context" | "meta";
      text: string;
      lineNo: number | null;
      /** 旧文件行号。新增行没有。 */
      oldNo: number | null;
      /** 新文件行号。删除行没有。 */
      newNo: number | null;
    };

/** 统一 diff 的一行。`lineNo` 仍是折叠间距用的那一列：删除用旧号，其余用新号。 */
export function diffLine(
  tone: "add" | "del" | "context" | "meta",
  text: string,
  oldNo: number | null,
  newNo: number | null,
): DiffFoldRow {
  const lineNo = tone === "del" ? oldNo : tone === "meta" ? null : newNo;
  return { kind: "line", tone, text, lineNo, oldNo, newNo };
}

/**
 * 把统一 diff 收成折叠行：块与块之间没出现的旧行变成
 * 「N unmodified lines」，块内的上下文和改动照原样留下。
 */
export function foldDiffLines(diff: string): DiffFoldRow[] {
  const rows: DiffFoldRow[] = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  let lastNo: number | null = null;
  const emit = (tone: "add" | "del" | "context", text: string, oldNo: number | null, newNo: number | null) => {
    const lineNo = tone === "del" ? oldNo : newNo;
    if (lineNo === null) {
      rows.push(diffLine(tone, text, oldNo, newNo));
      return;
    }
    if (lastNo === null) {
      if (lineNo > 1) rows.push({ kind: "collapse", count: lineNo - 1 });
    } else {
      const gap = lineNo - lastNo - 1;
      if (gap > 0) rows.push({ kind: "collapse", count: gap });
    }
    rows.push(diffLine(tone, text, oldNo, newNo));
    lastNo = lineNo;
  };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      lastNo = null;
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity ") ||
      line.startsWith("rename ") ||
      line.startsWith("copy ")
    ) {
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) {
      const text = line.replace(/^\\/, "").trim();
      rows.push(diffLine("meta", text, null, null));
      continue;
    }
    if (line.startsWith("+")) {
      emit("add", line.slice(1), null, newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      emit("del", line.slice(1), oldLine, null);
      oldLine += 1;
      continue;
    }
    const text = line.startsWith(" ") ? line.slice(1) : line;
    emit("context", text, oldLine, newLine);
    oldLine += 1;
    newLine += 1;
  }
  return rows;
}

/**
 * 展开灰条。有全文时按新文件补上未改动行；没有全文时只留下差异块。
 */
export function expandDiffLines(diff: string, source: string | null): DiffFoldRow[] {
  if (source == null) return foldDiffLines(diff).filter((row) => row.kind !== "collapse");
  const src = sourceLines(source);
  const hunks = parseHunks(diff);
  const rows: DiffFoldRow[] = [];
  let cursor = 1;
  let oldCursor = 1;
  const emitUntil = (until: number) => {
    while (cursor < until && cursor <= src.length) {
      rows.push(diffLine("context", src[cursor - 1] ?? "", oldCursor, cursor));
      oldCursor += 1;
      cursor += 1;
    }
  };
  for (const hunk of hunks) {
    emitUntil(hunk.newStart);
    let oldLine = hunk.oldStart;
    for (const line of hunk.lines) {
      if (line.kind === "meta") {
        rows.push(diffLine("meta", line.text, null, null));
        continue;
      }
      if (line.kind === "del") {
        rows.push(diffLine("del", line.text, oldLine, null));
        oldLine += 1;
        continue;
      }
      const text = cursor <= src.length ? (src[cursor - 1] ?? line.text) : line.text;
      if (line.kind === "add") rows.push(diffLine("add", text, null, cursor));
      else rows.push(diffLine("context", text, oldLine, cursor));
      if (line.kind === "context") oldLine += 1;
      cursor += 1;
    }
    oldCursor = oldLine;
  }
  emitUntil(src.length + 1);
  return rows;
}

/** 差异里的新文件一侧，不含灰条外面的原文。渲染预览在读不到全文时用它。 */
export function previewTextFromDiff(diff: string): string {
  const lines: string[] = [];
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+") || line.startsWith(" ")) lines.push(line.slice(1));
  }
  return lines.join("\n");
}

interface ParsedHunkLine {
  kind: "add" | "del" | "context" | "meta";
  text: string;
}

interface ParsedHunk {
  oldStart: number;
  newStart: number;
  lines: ParsedHunkLine[];
}

function parseHunks(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  for (const line of diff.split(/\r?\n/)) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file")
    ) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\")) current.lines.push({ kind: "meta", text: line.replace(/^\\/, "").trim() });
    else if (line.startsWith("+")) current.lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) current.lines.push({ kind: "del", text: line.slice(1) });
    else current.lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  return hunks;
}
