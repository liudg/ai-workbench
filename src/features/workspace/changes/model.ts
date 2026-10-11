/**
 * 文件变更只来自适配器事件，不看 Agent 种类。
 *
 * - `turn-diff`：回合统一 diff。适配器声明 `supports_turn_diff` 后写入。
 * - `tool-call` 且名字是 apply_patch / file_change：补丁事件。
 *
 * 其它 Agent 以后写入同样的事件，变更卡和会话文件就会出现。
 * 一条都没有时，侧栏保持空状态。
 */
import type { SessionEvent } from "../../../types.ts";

import { CODEX_DESKTOP } from "../codex-desktop.ts";

export type FileStatus = "A" | "M" | "D" | "R";

export interface FileChange {
  path: string;
  status: FileStatus;
  added: number;
  removed: number;
  diff: string;
}

export interface TurnChanges {
  id: string;
  files: FileChange[];
  added: number;
  removed: number;
}

/** 变更卡先列出的文件数，其余用「再显示」。 */
export const FILE_LIST_LIMIT = 3;

interface Draft {
  lines: string[];
  oldPath: string;
  newPath: string;
  renameTo: string;
  renamed: boolean;
  addedFile: boolean;
  deletedFile: boolean;
  added: number;
  removed: number;
}

export function filesChangedLabel(count: number): string {
  return count === 1
    ? CODEX_DESKTOP.fileChanged
    : CODEX_DESKTOP.filesChanged.replace("{count}", String(count));
}

/** 变更卡上会出现的动作。查看变更始终在；文件超出一屏时才有再显示。 */
export function changeActions(
  fileCount: number,
  listExpanded: boolean,
  revealed: boolean,
): string[] {
  const actions: string[] = [CODEX_DESKTOP.viewChanges];
  if (listExpanded && canShowMore(fileCount, revealed)) actions.push(CODEX_DESKTOP.showMore);
  return actions;
}

export function canShowMore(fileCount: number, revealed: boolean): boolean {
  return !revealed && fileCount > FILE_LIST_LIMIT;
}

export function visibleChangeFiles<T>(files: readonly T[], expanded: boolean, revealed: boolean): T[] {
  if (!expanded) return [];
  if (revealed || files.length <= FILE_LIST_LIMIT) return [...files];
  return files.slice(0, FILE_LIST_LIMIT);
}

export function isPatchTool(name: string): boolean {
  const key = name.trim().toLowerCase().replace(/[^a-z]/g, "");
  return key === "applypatch" || key === "filechange";
}

export function parseUnifiedDiff(diff: string): FileChange[] {
  const lines = diff.split(/\r?\n/);
  const files: FileChange[] = [];
  let current: Draft | null = null;
  const flush = () => {
    if (!current) return;
    const file = finishDraft(current);
    if (file.path) files.push(file);
    current = null;
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = emptyDraft();
      const paths = gitPaths(line);
      if (paths) {
        current.oldPath = paths.oldPath;
        current.newPath = paths.newPath;
      }
      current.lines.push(line);
      continue;
    }
    if (!current && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      current = emptyDraft();
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith("--- ")) current.oldPath = unquote(line.slice(4).trim());
    else if (line.startsWith("+++ ")) current.newPath = unquote(line.slice(4).trim());
    else if (line.startsWith("rename to ")) current.renameTo = line.slice("rename to ".length).trim();
    else if (line.startsWith("rename from ")) current.renamed = true;
    else if (line.startsWith("new file")) current.addedFile = true;
    else if (line.startsWith("deleted file")) current.deletedFile = true;
    else if (line.startsWith("+") && !line.startsWith("+++")) current.added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) current.removed += 1;
  }
  flush();
  return files;
}

const PATCH_SPLIT =
  /\n\n(?=(?:add|added|create|created|delete|deleted|remove|removed|update|updated|modify|modified|change|changed|rename|renamed|move|moved|[AMDR])\s+\S)/i;

const PATCH_HEADER =
  /^(add|added|create|created|delete|deleted|remove|removed|update|updated|modify|modified|change|changed|rename|renamed|move|moved|[AMDR])\s+(\S.*)$/i;

export function parsePatchDetail(detail: string): FileChange[] {
  const trimmed = detail.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(PATCH_SPLIT);
  const out: FileChange[] = [];
  for (const part of parts) {
    const lines = part.split(/\r?\n/);
    const header = lines[0] ?? "";
    const match = PATCH_HEADER.exec(header);
    if (!match) {
      out.push(...parseUnifiedDiff(part));
      continue;
    }
    const status = kindStatus(match[1]);
    const path = match[2].trim();
    const body = lines.slice(1).join("\n").trim();
    const parsed = body ? parseUnifiedDiff(body) : [];
    if (parsed.length === 1) {
      out.push({
        ...parsed[0],
        path: displayPath(path || parsed[0].path),
        status,
      });
    } else if (parsed.length > 1) {
      out.push(...parsed);
    } else if (path) {
      out.push({ path: displayPath(path), status, added: 0, removed: 0, diff: body });
    }
  }
  return out.filter((file) => file.path);
}

export function turnChanges(events: readonly SessionEvent[]): TurnChanges | null {
  let chosen: FileChange[] | null = null;
  let id = "";
  for (const event of events) {
    if (event.kind !== "turn-diff") continue;
    const files = parseUnifiedDiff(event.diff);
    if (files.length === 0) continue;
    chosen = files;
    id = event.turn_id || event.id;
  }
  if (chosen) return pack(id, chosen);

  const map = new Map<string, FileChange>();
  for (const event of events) {
    if (event.kind !== "tool-call" || !isPatchTool(event.name)) continue;
    const files = parsePatchDetail(event.detail ?? "");
    for (const file of files) map.set(normKey(file.path), file);
    if (files.length > 0) id = event.stream_id || event.id;
  }
  if (map.size === 0) return null;
  return pack(id, [...map.values()]);
}

export function sessionChanges(events: readonly SessionEvent[]): FileChange[] {
  const map = new Map<string, FileChange>();
  for (const slice of eventSlices(events)) {
    const changes = turnChanges(slice);
    if (!changes) continue;
    for (const file of changes.files) map.set(normKey(file.path), file);
  }
  return [...map.values()];
}

export function lastSlice(events: readonly SessionEvent[]): SessionEvent[] {
  const slices = eventSlices(events);
  return slices[slices.length - 1] ?? [];
}

export type PreviewKind = "html" | "markdown" | "text";

export function previewKindForPath(path: string): PreviewKind {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : "";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  return "text";
}

export function isFileHref(href: string): boolean {
  const raw = href.trim();
  if (!raw || /^(https?:|mailto:|data:|javascript:|#)/i.test(raw)) return false;
  if (/^file:/i.test(raw)) return true;
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/")) return true;
  if (raw.startsWith("./") || raw.startsWith("../") || raw.includes("/") || raw.includes("\\")) {
    return true;
  }
  const name = raw.split(/[?#]/)[0] ?? raw;
  return /\.[A-Za-z0-9]{1,8}$/.test(name);
}

/**
 * 把结论里的文件链接解析到项目目录内。
 * 越界、外链返回 null。调用方据此打开预览，读文件仍由后端再拦一次。
 */
export function resolvePreviewPath(projectPath: string, href: string): string | null {
  const root = projectPath.trim();
  if (!root) return null;
  const spec = hrefToPath(href);
  if (!spec) return null;
  const absolute = isAbsolutePath(spec) ? spec : joinPath(root, spec);
  const normal = normalizePath(absolute);
  if (!isInside(root, normal)) return null;
  return normal;
}

export function sameFile(projectPath: string, changePath: string, absolute: string): boolean {
  const root = normalizePath(projectPath).replace(/\/$/, "").toLowerCase();
  const abs = normalizePath(absolute).toLowerCase();
  const change = normalizePath(changePath).replace(/^\.\//, "").toLowerCase();
  if (!change) return false;
  if (abs === change) return true;
  if (root && abs === `${root}/${change}`.replace(/\/{2,}/g, "/")) return true;
  return change.length > 0 && (abs === change || abs.endsWith(`/${change}`));
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 变更页「上一轮」菜单。已提交、分支在参考里有尖角，子菜单没有打开。 */
export function diffScopeMenu(): { id: string; label: string; submenu: boolean }[] {
  return [
    { id: "turn", label: CODEX_DESKTOP.diffPreviousTurn, submenu: false },
    { id: "uncommitted", label: CODEX_DESKTOP.diffUncommitted, submenu: false },
    { id: "unstaged", label: CODEX_DESKTOP.diffUnstaged, submenu: false },
    { id: "staged", label: CODEX_DESKTOP.diffStaged, submenu: false },
    { id: "committed", label: CODEX_DESKTOP.diffCommitted, submenu: true },
    { id: "branch", label: CODEX_DESKTOP.diffBranch, submenu: true },
  ];
}

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

export function editedFilesLabel(files: readonly { path: string }[]): string {
  if (files.length === 1) {
    return CODEX_DESKTOP.editedFile.replace("{name}", baseName(files[0]?.path ?? ""));
  }
  return CODEX_DESKTOP.editedFiles.replace("{count}", String(files.length));
}

export function directoryOf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

export function groupByDirectory<T extends { path: string }>(
  files: readonly T[],
): { dir: string; files: T[] }[] {
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const file of files) {
    const dir = directoryOf(file.path);
    const list = map.get(dir);
    if (list) list.push(file);
    else {
      order.push(dir);
      map.set(dir, [file]);
    }
  }
  return order.map((dir) => ({ dir, files: map.get(dir) ?? [] }));
}

export function fileStatusTone(status: FileStatus): "add" | "del" | "neutral" {
  if (status === "A" || status === "M") return "add";
  if (status === "D") return "del";
  return "neutral";
}

/** `annotate.html (line 12)` → 路径和行号。行号从 1 开始。 */
export function fileLineRef(label: string): { path: string; line: number } | null {
  const match = /^(.*\S)\s+\(line\s+(\d+)\)\s*$/i.exec(label.trim());
  if (!match) return null;
  const line = Number(match[2]);
  if (!Number.isInteger(line) || line < 1) return null;
  const path = match[1].trim();
  if (!path) return null;
  return { path, line };
}

export function lineFromHref(href: string): number | null {
  const hash = href.split("#")[1]?.split("&")[0] ?? "";
  const match = /^L(\d+)$/i.exec(hash);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isInteger(line) && line >= 1 ? line : null;
}

export function isHtmlHref(href: string): boolean {
  const bare = href.trim().split(/[?#]/)[0] ?? "";
  return /\.html?$/i.test(bare);
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

export interface WordPart {
  text: string;
  changed: boolean;
}

export type DiffDisplayRow =
  | { kind: "collapse"; count: number }
  | {
      kind: "line";
      tone: "add" | "del" | "context" | "meta";
      text: string;
      lineNo: number | null;
      parts: WordPart[] | null;
    };

export function applyWordDiff(rows: readonly DiffFoldRow[]): DiffDisplayRow[] {
  const out: DiffDisplayRow[] = rows.map((row) =>
    row.kind === "collapse" ? row : { ...row, parts: null },
  );
  let index = 0;
  while (index < out.length) {
    const start = index;
    while (isTone(out[index], "del")) index += 1;
    const delEnd = index;
    while (isTone(out[index], "add")) index += 1;
    const addEnd = index;
    if (delEnd === start) {
      index = Math.max(index, start + 1);
      continue;
    }
    const pair = Math.min(delEnd - start, addEnd - delEnd);
    for (let cursor = 0; cursor < pair; cursor += 1) {
      const before = out[start + cursor];
      const after = out[delEnd + cursor];
      if (before?.kind !== "line" || after?.kind !== "line") continue;
      const parts = wordDiffParts(before.text, after.text);
      before.parts = parts.before;
      after.parts = parts.after;
    }
  }
  return out;
}

export function wordDiffParts(before: string, after: string): { before: WordPart[]; after: WordPart[] } {
  const left = tokenize(before);
  const right = tokenize(after);
  if (left.length * right.length > 4000) {
    const changed = before !== after;
    return {
      before: [{ text: before, changed }],
      after: [{ text: after, changed }],
    };
  }
  const shared = lcsMask(left, right);
  return {
    before: mergeParts(left, shared.left),
    after: mergeParts(right, shared.right),
  };
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

function isTone(row: DiffDisplayRow | undefined, tone: "add" | "del"): boolean {
  return row?.kind === "line" && row.tone === tone;
}

function tokenize(text: string): string[] {
  return text.match(/\s+|[A-Za-z0-9_]+|./g) ?? [];
}

function lcsMask(left: string[], right: string[]): { left: boolean[]; right: boolean[] } {
  const n = left.length;
  const m = right.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const leftChanged = new Array<boolean>(n).fill(true);
  const rightChanged = new Array<boolean>(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      leftChanged[i] = false;
      rightChanged[j] = false;
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1;
    else j += 1;
  }
  return { left: leftChanged, right: rightChanged };
}

function mergeParts(tokens: string[], changed: boolean[]): WordPart[] {
  const parts: WordPart[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const last = parts[parts.length - 1];
    if (last && last.changed === changed[index]) last.text += tokens[index] ?? "";
    else parts.push({ text: tokens[index] ?? "", changed: changed[index] ?? false });
  }
  return parts;
}

function eventSlices(events: readonly SessionEvent[]): SessionEvent[][] {
  const slices: SessionEvent[][] = [];
  let current: SessionEvent[] = [];
  for (const event of events) {
    if (event.kind === "user-message" && current.length > 0) {
      slices.push(current);
      current = [];
    }
    current.push(event);
  }
  if (current.length > 0) slices.push(current);
  return slices;
}

function pack(id: string, files: FileChange[]): TurnChanges {
  return {
    id: id || files.map((file) => file.path).join("|"),
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

function emptyDraft(): Draft {
  return {
    lines: [],
    oldPath: "",
    newPath: "",
    renameTo: "",
    renamed: false,
    addedFile: false,
    deletedFile: false,
    added: 0,
    removed: 0,
  };
}

function finishDraft(draft: Draft): FileChange {
  const next = stripMarker(draft.newPath);
  const prev = stripMarker(draft.oldPath);
  const renamed =
    draft.renamed ||
    Boolean(prev && next && prev !== next && prev !== "/dev/null" && next !== "/dev/null");
  let status: FileStatus = "M";
  let path = next && next !== "/dev/null" ? next : prev;
  if (draft.deletedFile || next === "/dev/null") {
    status = "D";
    path = prev && prev !== "/dev/null" ? prev : path;
  } else if (draft.addedFile || prev === "/dev/null" || (!prev && next)) {
    status = "A";
    path = next && next !== "/dev/null" ? next : path;
  } else if (renamed) {
    status = "R";
    path = draft.renameTo || next || path;
  }
  if (draft.renameTo && status === "R") path = draft.renameTo;
  if (!path || path === "/dev/null") {
    return { path: "", status, added: draft.added, removed: draft.removed, diff: draft.lines.join("\n") };
  }
  return {
    path: displayPath(path),
    status,
    added: draft.added,
    removed: draft.removed,
    diff: draft.lines.join("\n"),
  };
}

function gitPaths(line: string): { oldPath: string; newPath: string } | null {
  const rest = line.slice("diff --git ".length).trim();
  const quoted = /^"([^"]+)"\s+"([^"]+)"$/.exec(rest);
  if (quoted) return { oldPath: quoted[1], newPath: quoted[2] };
  const split = rest.indexOf(" b/");
  if (rest.startsWith("a/") && split > 0) {
    return { oldPath: rest.slice(0, split), newPath: rest.slice(split + 1) };
  }
  return null;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function stripMarker(path: string): string {
  const bare = unquote(path.trim());
  if (bare === "/dev/null") return bare;
  if (bare.startsWith("a/") || bare.startsWith("b/")) return bare.slice(2);
  return bare;
}

function displayPath(path: string): string {
  return stripMarker(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

function kindStatus(kind: string): FileStatus {
  const key = kind.trim().toLowerCase();
  if (key === "a" || key === "add" || key === "added" || key === "create" || key === "created") {
    return "A";
  }
  if (key === "d" || key === "delete" || key === "deleted" || key === "remove" || key === "removed") {
    return "D";
  }
  if (key === "r" || key === "rename" || key === "renamed" || key === "move" || key === "moved") {
    return "R";
  }
  return "M";
}

function normKey(path: string): string {
  return displayPath(path).toLowerCase();
}

function hrefToPath(href: string): string | null {
  const trimmed = href.trim().replace(/^<|>$/g, "");
  if (!trimmed || /^(https?:|mailto:|data:|javascript:|#)/i.test(trimmed)) return null;
  const filePath = fileUrlPath(trimmed);
  const raw = filePath ?? trimmed;
  const cut = raw.split(/[?#]/)[0] ?? raw;
  try {
    return decodeURIComponent(cut);
  } catch {
    return cut;
  }
}

function fileUrlPath(href: string): string | null {
  if (!/^file:/i.test(href)) return null;
  try {
    const url = new URL(href);
    let path = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    return path;
  } catch {
    return null;
  }
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}

function joinPath(root: string, rel: string): string {
  const slash = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${slash}${rel.replace(/^[\\/]+/, "")}`;
}

export function normalizePath(path: string): string {
  const unix = path.replace(/\\/g, "/");
  const drive = /^[A-Za-z]:/.exec(unix)?.[0] ?? "";
  const rooted = unix.startsWith("/");
  const rest = drive ? unix.slice(drive.length) : unix;
  const stack: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  const body = stack.join("/");
  if (drive) return `${drive}/${body}`;
  if (rooted) return `/${body}`;
  return body;
}

function isInside(root: string, candidate: string): boolean {
  const base = normalizePath(root).replace(/\/$/, "").toLowerCase();
  const next = normalizePath(candidate).toLowerCase();
  return next === base || next.startsWith(`${base}/`);
}
