/**
 * 文件变更只来自适配器事件，不看 Agent 种类。
 *
 * - `turn-diff`：回合统一 diff。适配器声明 `supports_turn_diff` 后写入。
 * - `tool-call` 且名字是 apply_patch / file_change：补丁事件。
 *
 * 其它 Agent 以后写入同样的事件，变更卡和会话文件就会出现。
 * 一条都没有时，侧栏保持空状态。
 */
import type { SessionEvent } from "../../types.ts";

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
