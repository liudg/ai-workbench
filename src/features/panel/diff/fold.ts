export function unmodifiedLinesLabel(count: number): string {
  return `${count} unmodified lines`;
}

export type DiffFoldRow =
  | { kind: "collapse"; count: number }
  | { kind: "line"; tone: "add" | "del" | "context" | "meta"; text: string; lineNo: number | null };

/**
 * 把统一 diff 收成 Codex 那样的行：块与块之间没出现的旧行变成
 * 「N unmodified lines」，块内的上下文和改动照原样留下。
 */
export function foldDiffLines(diff: string): DiffFoldRow[] {
  const rows: DiffFoldRow[] = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  let lastNo: number | null = null;
  const emit = (tone: "add" | "del" | "context", text: string, lineNo: number) => {
    if (lastNo === null) {
      if (lineNo > 1) rows.push({ kind: "collapse", count: lineNo - 1 });
    } else {
      const gap = lineNo - lastNo - 1;
      if (gap > 0) rows.push({ kind: "collapse", count: gap });
    }
    rows.push({ kind: "line", tone, text, lineNo });
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
      rows.push({ kind: "line", tone: "meta", text, lineNo: null });
      continue;
    }
    if (line.startsWith("+")) {
      emit("add", line.slice(1), newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      emit("del", line.slice(1), oldLine);
      oldLine += 1;
      continue;
    }
    const text = line.startsWith(" ") ? line.slice(1) : line;
    emit("context", text, newLine);
    oldLine += 1;
    newLine += 1;
  }
  return rows;
}

export function sourceLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 去掉只改空白的增删行。git 范围另由 `git diff -w` 处理。 */
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

/**
 * 展开灰条。有全文时按新文件补上未改动行；没有全文时只留下差异块。
 */
export function expandDiffLines(diff: string, source: string | null): DiffFoldRow[] {
  if (source == null) return foldDiffLines(diff).filter((row) => row.kind !== "collapse");
  const src = sourceLines(source);
  const hunks = parseHunks(diff);
  const rows: DiffFoldRow[] = [];
  let cursor = 1;
  const emitUntil = (until: number) => {
    while (cursor < until && cursor <= src.length) {
      rows.push({ kind: "line", tone: "context", text: src[cursor - 1] ?? "", lineNo: cursor });
      cursor += 1;
    }
  };
  for (const hunk of hunks) {
    emitUntil(hunk.newStart);
    let oldLine = hunk.oldStart;
    for (const line of hunk.lines) {
      if (line.kind === "meta") {
        rows.push({ kind: "line", tone: "meta", text: line.text, lineNo: null });
        continue;
      }
      if (line.kind === "del") {
        rows.push({ kind: "line", tone: "del", text: line.text, lineNo: oldLine });
        oldLine += 1;
        continue;
      }
      const text = cursor <= src.length ? (src[cursor - 1] ?? line.text) : line.text;
      rows.push({
        kind: "line",
        tone: line.kind === "add" ? "add" : "context",
        text,
        lineNo: cursor,
      });
      if (line.kind === "context") oldLine += 1;
      cursor += 1;
    }
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

function collapseSpace(text: string): string {
  return text.replace(/\s+/g, "");
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
