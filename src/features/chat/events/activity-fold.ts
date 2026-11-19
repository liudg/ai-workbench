import type { SessionEvent } from "../../../types/index.ts";
import { normalizePath, relativizeDisplayText } from "../../../shared/path.ts";
import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import { hasGeneratedImages } from "./generated-images.ts";
import { hasThinkingBody } from "./thinking-summary.ts";

/**
 * 时间线展示层把相邻的工具调用收成一行。
 * 只读当前事件的 name / summary / images，不改协议，也不查 MCP 目录。
 * 旁白或思考出现时拆分工具组，并保留事件顺序。
 * 查看图像单独成行，不并进命令摘要。
 */

export type ToolCallEvent = Extract<SessionEvent, { kind: "tool-call" }>;

export type ActivityPiece =
  | { type: "event"; event: SessionEvent }
  | {
      type: "images";
      id: string;
      count: number;
      paths: string[];
    }
  | {
      type: "tools";
      id: string;
      summary: string;
      webSearch: boolean;
      steps: { id: string; title: string; event: ToolCallEvent }[];
    };

const TITLE_LIMIT = 48;
const COMMAND_TARGET_LIMIT = 32;
const SHORT_TARGET_LIMIT = 28;

export function foldActivity(events: readonly SessionEvent[], projectPath = ""): ActivityPiece[] {
  const pieces: ActivityPiece[] = [];
  let tools: ToolCallEvent[] = [];

  const flushTools = () => {
    if (tools.length === 0) return;
    pieces.push(toolPiece(tools, projectPath));
    tools = [];
  };

  for (const event of events) {
    if (event.kind === "background-task") continue;
    if (hasGeneratedImages(event)) {
      flushTools();
      pieces.push({ type: "event", event });
      continue;
    }
    if (event.kind === "tool-call" && isViewedImages(event)) {
      flushTools();
      pieces.push(imagePiece(event));
      continue;
    }
    if (event.kind === "tool-call") {
      tools.push(event);
      continue;
    }
    // 没有正文的思考不占位，也不把前后的工具拆成两行。
    if (event.kind === "thinking" && !hasThinkingBody(event.text)) continue;
    flushTools();
    pieces.push({ type: "event", event });
  }
  flushTools();
  return pieces;
}

interface KindBucket {
  count: number;
  nameless: number;
  seenPaths: Set<string>;
  targets: string[];
}

export function activitySummary(
  calls: readonly ToolCallEvent[],
  projectPath = "",
): { text: string; webSearch: boolean } {
  const servers: string[] = [];
  const seen = new Set<string>();
  let web = false;
  const buckets = new Map<ToolKind, KindBucket>();
  for (const call of calls) {
    if (isWebSearch(call)) {
      web = true;
      continue;
    }
    const server = integrationServer(call);
    if (server) {
      const key = server.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        servers.push(server);
      }
      continue;
    }
    const kind = toolKind(call.name);
    let bucket = buckets.get(kind);
    if (!bucket) {
      bucket = { count: 0, nameless: 0, seenPaths: new Set(), targets: [] };
      buckets.set(kind, bucket);
    }
    if (kind === "read" || kind === "edit") {
      const file = fileCallTarget(call, projectPath);
      if (file) {
        bucket.seenPaths.add(file.key);
        if (bucket.targets.length < 2 && !bucket.targets.includes(file.label)) {
          bucket.targets.push(file.label);
        }
      } else {
        bucket.nameless += 1;
      }
      bucket.count = bucket.seenPaths.size + bucket.nameless;
      continue;
    }
    bucket.count += 1;
    if (bucket.targets.length < 2) {
      const target = callTarget(call, kind, projectPath);
      if (target && !bucket.targets.includes(target)) bucket.targets.push(target);
    }
  }
  let text: string;
  if (servers.length > 0) text = integrationLine(servers);
  else if (buckets.size === 0 && web) text = DESKTOP_ZH.activitySearchedWeb;
  else {
    const effective =
      buckets.size > 0
        ? buckets
        : new Map<ToolKind, KindBucket>([
            ["command", { count: calls.length, nameless: calls.length, seenPaths: new Set(), targets: [] }],
          ]);
    text = countedLine(effective);
  }
  return { text, webSearch: web && text !== DESKTOP_ZH.activitySearchedWeb };
}

type ToolKind = "command" | "read" | "search" | "edit" | "fetch" | "tool";

/** 按适配器写入的工具名分类。名字来自各 Agent 自己（Claude `Read`、Cursor 和 Antigravity 的 ACP 种类、`command`）。 */
const TOOL_KINDS: Record<string, ToolKind> = {
  command: "command",
  read: "read",
  notebookread: "read",
  readfile: "read",
  viewfile: "read",
  search: "search",
  grep: "search",
  glob: "search",
  ls: "search",
  listdir: "search",
  grepsearch: "search",
  findbyname: "search",
  edit: "edit",
  write: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  delete: "edit",
  deletefile: "edit",
  move: "edit",
  movefile: "edit",
  editfile: "edit",
  writefile: "edit",
  writetofile: "edit",
  replacefilecontent: "edit",
  multireplacefilecontent: "edit",
  webfetch: "fetch",
  readurlcontent: "fetch",
};

const GENERIC_COMMAND_TOKENS = new Set([
  "command",
  "terminal",
  "bash",
  "powershell",
  "pwsh",
  "cmd",
  "sh",
  "zsh",
  "shell",
]);

const GENERIC_FILE_TOKENS = new Set([
  "file",
  "files",
  "read",
  "readfile",
  "viewfile",
  "notebookread",
  "edit",
  "editfile",
  "write",
  "writefile",
  "writetofile",
  "multiedit",
  "notebookedit",
  "delete",
  "deletefile",
  "move",
  "movefile",
  "createfile",
  "replacefilecontent",
  "multireplacefilecontent",
]);

function toolKind(name: string): ToolKind {
  return TOOL_KINDS[normalizeToken(name)] ?? "tool";
}

function normalizeToken(value: string): string {
  return value.trim().replace(/[\s_-]/g, "").toLowerCase();
}

const PART_LABELS: Record<ToolKind, string> = {
  command: DESKTOP_ZH.activityPartCommands,
  read: DESKTOP_ZH.activityPartReads,
  search: DESKTOP_ZH.activityPartSearches,
  edit: DESKTOP_ZH.activityPartEdits,
  fetch: DESKTOP_ZH.activityPartFetches,
  tool: DESKTOP_ZH.activityPartTools,
};

const PART_ONE_TARGET: Record<ToolKind, string> = {
  command: DESKTOP_ZH.activityPartCommandTarget,
  read: DESKTOP_ZH.activityPartReadTarget,
  search: DESKTOP_ZH.activityPartSearchTarget,
  edit: DESKTOP_ZH.activityPartEditTarget,
  fetch: DESKTOP_ZH.activityPartFetchTarget,
  tool: DESKTOP_ZH.activityPartToolTarget,
};

const PART_MANY_TARGET: Record<ToolKind, string> = {
  command: DESKTOP_ZH.activityPartCommandsTarget,
  read: DESKTOP_ZH.activityPartReadsTarget,
  search: DESKTOP_ZH.activityPartSearchesTarget,
  edit: DESKTOP_ZH.activityPartEditsTarget,
  fetch: DESKTOP_ZH.activityPartFetchesTarget,
  tool: DESKTOP_ZH.activityPartToolsTarget,
};

/** 按出现顺序逐类列出，有具体对象时带出代表性的文件名或命令。 */
function countedLine(buckets: ReadonlyMap<ToolKind, KindBucket>): string {
  const multiKind = buckets.size > 1;
  const parts = [...buckets].map(([kind, bucket]) => formatKindPart(kind, bucket, multiKind));
  return DESKTOP_ZH.activityDone.replace("{parts}", parts.join("，"));
}

function formatKindPart(kind: ToolKind, bucket: KindBucket, multiKind: boolean): string {
  if (bucket.targets.length === 0) {
    return PART_LABELS[kind].replace("{count}", String(bucket.count));
  }
  if (bucket.count === 1) {
    return PART_ONE_TARGET[kind].replace("{target}", bucket.targets[0]);
  }
  const filePair = !multiKind && (kind === "read" || kind === "edit");
  if (filePair && bucket.count === 2 && bucket.targets.length === 2) {
    return PART_ONE_TARGET[kind].replace("{target}", `${bucket.targets[0]}、${bucket.targets[1]}`);
  }
  const head = filePair ? bucket.targets.slice(0, 2).join("、") : bucket.targets[0];
  return PART_MANY_TARGET[kind]
    .replace("{target}", head)
    .replace("{count}", String(bucket.count));
}

function fileCallTarget(call: ToolCallEvent, projectPath: string): { key: string; label: string } | null {
  const raw = stripStatus(firstLine(call.summary) ?? "");
  const token = normalizeToken(raw);
  if (!raw || token === normalizeToken(call.name) || GENERIC_FILE_TOKENS.has(token)) return null;
  const unwrapped = unwrapFileTitle(raw);
  if (!unwrapped) return null;
  const relative = relativizeDisplayText(unwrapped, projectPath).trim();
  const base = fileBase(relative);
  if (!base) return null;
  return {
    key: normalizePath(relative).toLowerCase(),
    label: clipCodePoints(base, SHORT_TARGET_LIMIT),
  };
}

/** ACP 初始标题形如 `File /C:/ws/n.txt` 或 `File a`：只有后面真是路径或带扩展名文件名时才取用。 */
function unwrapFileTitle(raw: string): string | null {
  const prefixed = /^(?:(?:Read|Edit|Write|View|Delete|Move|Create)\s+)?File\s+(.+)$/i.exec(raw.trim());
  if (!prefixed) return raw.trim();
  const candidate = stripTicks(prefixed[1]);
  if (!candidate || !/[\\/.]/.test(candidate)) return null;
  return candidate;
}

function stripTicks(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function callTarget(call: ToolCallEvent, kind: ToolKind, projectPath: string): string | null {
  if (kind === "command") {
    const step = activityStepTitle(call.name, call.summary, projectPath);
    if (!step || step === DESKTOP_ZH.activityCommandStep) return null;
    if (GENERIC_COMMAND_TOKENS.has(normalizeToken(step))) return null;
    return clipCodePoints(step, COMMAND_TARGET_LIMIT);
  }
  if (kind === "tool") {
    const named = titleFromName(call.name);
    if (named && named !== "工具调用" && named !== DESKTOP_ZH.activityCommandStep) {
      return clipCodePoints(named, SHORT_TARGET_LIMIT);
    }
    const raw = relativizeDisplayText(stripStatus(firstLine(call.summary) ?? ""), projectPath).trim();
    if (!raw || raw === "工具调用" || raw === DESKTOP_ZH.activityCommandStep) return null;
    return clipCodePoints(raw, SHORT_TARGET_LIMIT);
  }
  const raw = relativizeDisplayText(stripStatus(firstLine(call.summary) ?? ""), projectPath).trim();
  const rawToken = normalizeToken(raw);
  if (!raw || rawToken === normalizeToken(call.name) || TOOL_KINDS[rawToken] === kind) return null;
  return clipCodePoints(raw, SHORT_TARGET_LIMIT);
}

function fileBase(path: string): string {
  const parts = path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path.trim();
}

function clipCodePoints(text: string, limit: number): string {
  const trimmed = text.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= limit) return trimmed;
  return `${chars.slice(0, limit - 1).join("").trimEnd()}…`;
}

/** 展开后的子步骤标题。不把 PowerShell 路径当作主行，裁剪前先收成相对项目路径。 */
export function activityStepTitle(name: string, summary: string, projectPath = ""): string {
  const line = firstLine(summary);
  if (!line) return titleFromName(name);
  const stripped = stripStatus(line);
  if (/-EncodedCommand\b/i.test(stripped)) return DESKTOP_ZH.activityCommandStep;
  const labeled = parseLabeledMcp(stripped);
  if (labeled) return clip(labeled.tool || labeled.server);
  const payload = unwrapShell(stripped);
  if (payload !== null) return titleFromShell(payload, projectPath);
  if (looksLikeShellPath(stripped)) return DESKTOP_ZH.activityCommandStep;
  return clip(relativizeDisplayText(stripped, projectPath));
}

const IMAGE_NAMES = new Set(["image", "imageview", "localimage"]);

export function isViewedImages(event: ToolCallEvent): boolean {
  return IMAGE_NAMES.has(normalizeToken(event.name));
}

export function viewedImagesLabel(count: number): string {
  return DESKTOP_ZH.activityViewedImages.replace("{count}", String(count));
}

function imagePiece(event: ToolCallEvent): ActivityPiece {
  const paths = viewedPaths(event);
  return {
    type: "images",
    id: event.id,
    count: paths.length > 0 ? paths.length : 1,
    paths,
  };
}

function viewedPaths(event: ToolCallEvent): string[] {
  const listed = unique((event.images ?? []).map((item) => item.trim()).filter((item) => item.length > 0));
  if (listed.length > 0) return listed;
  const summary = firstLine(event.summary) ?? "";
  if (!summary || summary === "图片") return [];
  return [summary];
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function toolPiece(calls: readonly ToolCallEvent[], projectPath: string): ActivityPiece {
  const summary = activitySummary(calls, projectPath);
  return {
    type: "tools",
    id: calls[0].id,
    summary: summary.text,
    webSearch: summary.webSearch,
    steps: calls.map((event) => ({
      id: event.id,
      title: activityStepTitle(event.name, event.summary, projectPath),
      event,
    })),
  };
}

function integrationLine(names: readonly string[]): string {
  return DESKTOP_ZH.activityUsedIntegrations.replace("{names}", joinNames(names));
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} 和 ${names[1]}`;
  return `${names.slice(0, -1).join("、")} 和 ${names[names.length - 1]}`;
}

export function isWebSearch(event: ToolCallEvent): boolean {
  return normalizeToken(event.name) === "websearch";
}

function integrationServer(event: ToolCallEvent): string | null {
  const line = firstLine(event.summary);
  const labeled = line ? parseLabeledMcp(stripStatus(line)) : null;
  if (labeled?.server) return labeled.server;
  return parseCodedMcp(event.name)?.server ?? (line ? parseCodedMcp(stripStatus(line))?.server ?? null : null);
}

/** 只看适配器写入的 name：MCP 取工具名，命令统称「命令」。 */
export function titleFromName(name: string): string {
  const coded = parseCodedMcp(name);
  if (coded?.tool) return clip(coded.tool);
  if (name.trim() === "command") return DESKTOP_ZH.activityCommandStep;
  return clip(name.trim() || "工具调用");
}

function titleFromShell(payload: string, projectPath: string): string {
  const inner = stripAssignment(payload).trim();
  if (!inner) return DESKTOP_ZH.activityCommandStep;
  const nested = unwrapShell(inner);
  const body = (nested !== null && nested.trim() ? stripAssignment(nested) : inner).trim();
  if (!body || looksLikeShellPath(body) || /-EncodedCommand\b/i.test(body)) return DESKTOP_ZH.activityCommandStep;
  return clip(relativizeDisplayText(body, projectPath));
}

function parseLabeledMcp(line: string): { server: string; tool: string } | null {
  const match = /^MCP\s+(\S+)(?:\s+(\S+))?/i.exec(line.trim());
  if (!match) return null;
  return { server: match[1], tool: match[2] ?? "" };
}

function parseCodedMcp(value: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/i.exec(value.trim());
  if (!match) return null;
  return { server: match[1], tool: match[2] };
}

function firstLine(summary: string): string | null {
  const line = summary
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? null;
}

function stripStatus(line: string): string {
  return line.replace(/\s*→\s*.+$/u, "").trim();
}

function unwrapShell(line: string): string | null {
  const named = /(?:powershell|pwsh|cmd)(?:\.exe)?/i.test(line);
  const wrapped =
    named &&
    (/[\\/]/.test(line) || /(?:^|\s)-(?:Command|c)\s+/i.test(line) || /(?:^|\s)\/c\s+/i.test(line));
  if (!wrapped) return null;
  const command = /(?:^|\s)-(?:Command|c)\s+([\s\S]+)$/i.exec(line);
  if (command) return unquote(command[1]);
  const slashC = /(?:^|\s)\/c\s+([\s\S]+)$/i.exec(line);
  if (slashC) return unquote(slashC[1]);
  return "";
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"');
  }
  return text;
}

function stripAssignment(body: string): string {
  return body.replace(/^(?:\$[\w]+\s*=\s*)+/, "");
}

function looksLikeShellPath(text: string): boolean {
  return /(?:powershell|pwsh|cmd)(?:\.exe)?/i.test(text) && /[\\/]/.test(text);
}

function clip(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return DESKTOP_ZH.activityCommandStep;
  const chars = Array.from(trimmed);
  if (chars.length <= TITLE_LIMIT) return trimmed;
  if (!trimmed.includes(" ") && /[\\/]/.test(trimmed)) {
    const base = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed;
    const baseChars = Array.from(base);
    if (baseChars.length <= TITLE_LIMIT) return base;
    return `${baseChars.slice(0, TITLE_LIMIT - 1).join("")}…`;
  }
  return `${chars.slice(0, TITLE_LIMIT - 1).join("").trimEnd()}…`;
}
