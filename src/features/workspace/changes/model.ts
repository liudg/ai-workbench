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
