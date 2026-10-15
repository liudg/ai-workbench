import type { SessionEvent } from "../../../types/index.ts";
import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";

/**
 * 时间线展示层把相邻的工具调用收成一行。
 * 只读当前事件的 name / summary / images，不改协议，也不查 MCP 目录。
 * 旁白或思考一插进来就拆组。思考正文不画出来。
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

/** 进行中的一轮，最后一条可见事件仍是思考时，末行显示「正在思考」。 */
export function isLiveThinking(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const kind = events[i].kind;
    if (kind === "status-changed" || kind === "context-usage" || kind === "session-usage") continue;
    return kind === "thinking";
  }
  return false;
}

const TITLE_LIMIT = 48;

export function foldActivity(events: readonly SessionEvent[]): ActivityPiece[] {
  const pieces: ActivityPiece[] = [];
  let tools: ToolCallEvent[] = [];

  const flushTools = () => {
    if (tools.length === 0) return;
    pieces.push(toolPiece(tools));
    tools = [];
  };

  for (const event of events) {
    if (event.kind === "tool-call" && isViewedImages(event)) {
      flushTools();
      pieces.push(imagePiece(event));
      continue;
    }
    if (event.kind === "tool-call") {
      tools.push(event);
      continue;
    }
    flushTools();
    if (event.kind === "thinking") continue;
    pieces.push({ type: "event", event });
  }
  flushTools();
  return pieces;
}

export function activitySummary(calls: readonly ToolCallEvent[]): { text: string; webSearch: boolean } {
  const servers: string[] = [];
  const seen = new Set<string>();
  let web = false;
  let other = 0;
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
    other += 1;
  }
  let text: string;
  if (servers.length > 0) text = integrationLine(servers);
  else if (other === 0 && web) text = DESKTOP_ZH.activitySearchedWeb;
  else text = commandLine(other > 0 ? other : calls.length);
  return { text, webSearch: web && text !== DESKTOP_ZH.activitySearchedWeb };
}

/** 展开后的子步骤标题。不把 PowerShell 路径当作主行。 */
export function activityStepTitle(name: string, summary: string): string {
  const line = firstLine(summary);
  if (!line) return titleFromName(name);
  const stripped = stripStatus(line);
  if (/-EncodedCommand\b/i.test(stripped)) return DESKTOP_ZH.activityCommandStep;
  const labeled = parseLabeledMcp(stripped);
  if (labeled) return clip(labeled.tool || labeled.server);
  const payload = unwrapShell(stripped);
  if (payload !== null) return titleFromShell(payload);
  if (looksLikeShellPath(stripped)) return DESKTOP_ZH.activityCommandStep;
  return clip(stripped);
}

const IMAGE_NAMES = new Set(["image", "imageview", "imagegeneration", "localimage"]);

export function isViewedImages(event: ToolCallEvent): boolean {
  return IMAGE_NAMES.has(event.name.replace(/[_-]/g, "").toLowerCase());
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

function toolPiece(calls: readonly ToolCallEvent[]): ActivityPiece {
  const summary = activitySummary(calls);
  return {
    type: "tools",
    id: calls[0].id,
    summary: summary.text,
    webSearch: summary.webSearch,
    steps: calls.map((event) => ({
      id: event.id,
      title: activityStepTitle(event.name, event.summary),
      event,
    })),
  };
}

function integrationLine(names: readonly string[]): string {
  return DESKTOP_ZH.activityUsedIntegrations.replace("{names}", joinNames(names));
}

function commandLine(count: number): string {
  return DESKTOP_ZH.activityRanCommands.replace("{count}", String(count));
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} 和 ${names[1]}`;
  return `${names.slice(0, -1).join("、")} 和 ${names[names.length - 1]}`;
}

function isWebSearch(event: ToolCallEvent): boolean {
  return event.name.replace(/[_-]/g, "").toLowerCase() === "websearch";
}

function integrationServer(event: ToolCallEvent): string | null {
  const line = firstLine(event.summary);
  const labeled = line ? parseLabeledMcp(stripStatus(line)) : null;
  if (labeled?.server) return labeled.server;
  return parseCodedMcp(event.name)?.server ?? (line ? parseCodedMcp(stripStatus(line))?.server ?? null : null);
}

function titleFromName(name: string): string {
  const coded = parseCodedMcp(name);
  if (coded?.tool) return clip(coded.tool);
  if (name.trim() === "command") return DESKTOP_ZH.activityCommandStep;
  return clip(name.trim() || "工具调用");
}

function titleFromShell(payload: string): string {
  const inner = stripAssignment(payload).trim();
  if (!inner) return DESKTOP_ZH.activityCommandStep;
  const nested = unwrapShell(inner);
  const body = (nested !== null && nested.trim() ? stripAssignment(nested) : inner).trim();
  if (!body || looksLikeShellPath(body) || /-EncodedCommand\b/i.test(body)) return DESKTOP_ZH.activityCommandStep;
  return clip(body);
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
  if (trimmed.length <= TITLE_LIMIT) return trimmed;
  if (!trimmed.includes(" ") && /[\\/]/.test(trimmed)) {
    const base = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed;
    if (base.length <= TITLE_LIMIT) return base;
    return `${base.slice(0, TITLE_LIMIT - 1)}…`;
  }
  return `${trimmed.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}
