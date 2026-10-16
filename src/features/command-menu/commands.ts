import { showsFileChanges } from "../changes-model/capabilities.ts";
import { sessionAgents } from "../../lib/agents.ts";
import type { AgentInstallation, AgentKind, ChangeCapabilities } from "../../types/index.ts";
import { COMMAND_MENU_COPY as COPY } from "./copy.ts";
import { commandFilter } from "./fuzzy.ts";

/** 空查询时最近聊天的条数。Codex 常量 Do = 7。 */
export const RECENT_CHAT_LIMIT = 7;

export type CommandGroup =
  | "suggested"
  | "settings"
  | "thread"
  | "navigation"
  | "panels"
  | "workspace"
  | "pinned"
  | "recent"
  | "chats";

export type PaletteCommandId =
  | "new-thread"
  | "new-standalone"
  | "open-folder"
  | "settings"
  | "search-chats"
  | "search-files"
  | "archive"
  | "rename"
  | "pin"
  | "delete"
  | "fork"
  | "toggle-files"
  | "toggle-changes";

export interface PaletteRow {
  key: string;
  kind: "command" | "chat";
  commandId?: PaletteCommandId;
  sessionId?: string;
  projectId?: string;
  label: string;
  group: CommandGroup;
  groupLabel: string;
  shortcut?: string;
}

export interface PaletteSession {
  id: string;
  projectId: string;
  title: string;
  archived: boolean;
  updatedAt: number;
  pinned: boolean;
}

export interface PaletteCaps {
  supports_archive?: boolean;
  supports_rename?: boolean;
  supports_delete?: boolean;
  supports_fork?: boolean;
  changes?: ChangeCapabilities;
}

export interface PaletteInput {
  query: string;
  mode: "commands" | "chats";
  sessions: readonly PaletteSession[];
  activeSessionId: string | null;
  caps: PaletteCaps | null;
  canNewThread: boolean;
  canStandalone: boolean;
  canSearchFiles: boolean;
}

const GROUP_ORDER: readonly CommandGroup[] = [
  "suggested",
  "settings",
  "thread",
  "navigation",
  "panels",
  "workspace",
  "pinned",
  "recent",
  "chats",
];

const SUGGESTED = new Set<PaletteCommandId>(["new-thread", "open-folder"]);

/**
 * 新聊天用的 Agent 只从「能开会话」的安装列表里挑。
 * 优先当前会话，其次项目默认，其次用户最近选过的。不写死某一种类。
 */
export function resolveCommandAgent(input: {
  installations: AgentInstallation[] | null | undefined;
  activeAgent: AgentKind | null;
  projectDefault: AgentKind | null;
  preferred: AgentKind | null;
}): AgentKind | null {
  const usable = sessionAgents(input.installations);
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0].kind;
  const ranked = [input.activeAgent, input.projectDefault, input.preferred];
  for (const kind of ranked) {
    if (kind && usable.some((item) => item.kind === kind)) return kind;
  }
  return usable[0].kind;
}

export function buildPaletteRows(input: PaletteInput): PaletteRow[] {
  const query = input.query.trim();
  if (input.mode === "chats") return sortGroups(chatRows(input, query));
  const items = commandItems(input);
  const commands = query
    ? items.filter((row) => commandFilter(row.label, query) > 0)
    : placeSuggested(items);
  return sortGroups([...commands, ...chatRows(input, query)]);
}

function commandItems(input: PaletteInput): PaletteRow[] {
  const active = input.sessions.find((session) => session.id === input.activeSessionId) ?? null;
  const rows: PaletteRow[] = [];
  if (input.canNewThread) rows.push(command("new-thread", COPY.newThread, "thread", COPY.shortcutNew));
  if (input.canStandalone) rows.push(command("new-standalone", COPY.newStandalone, "thread"));
  rows.push(command("search-chats", COPY.searchChats, "thread"));
  if (active && input.caps?.supports_rename === true) {
    rows.push(command("rename", COPY.rename, "thread"));
  }
  if (active) rows.push(command("pin", COPY.pin, "thread"));
  if (active && input.caps?.supports_archive === true) {
    rows.push(
      command(
        "archive",
        active.archived ? COPY.unarchive : COPY.archive,
        "thread",
        active.archived ? undefined : COPY.shortcutArchive,
      ),
    );
  }
  if (active && input.caps?.supports_fork === true) rows.push(command("fork", COPY.fork, "thread"));
  if (active && input.caps?.supports_delete === true) {
    rows.push(command("delete", COPY.deleteChat, "thread", COPY.shortcutDelete));
  }
  if (input.canSearchFiles) rows.push(command("search-files", COPY.searchFiles, "navigation"));
  if (active) rows.push(command("toggle-files", COPY.toggleFiles, "navigation"));
  if (active && showsFileChanges(input.caps?.changes)) {
    rows.push(command("toggle-changes", COPY.toggleChanges, "panels"));
  }
  rows.push(command("open-folder", COPY.openFolder, "workspace"));
  rows.push(command("settings", COPY.settings, "settings"));
  return rows;
}

function command(
  id: PaletteCommandId,
  label: string,
  group: CommandGroup,
  shortcut?: string,
): PaletteRow {
  return {
    key: id,
    kind: "command",
    commandId: id,
    label,
    group,
    groupLabel: COPY.groups[group],
    shortcut,
  };
}

function placeSuggested(items: readonly PaletteRow[]): PaletteRow[] {
  const suggested = items
    .filter((row) => row.commandId && SUGGESTED.has(row.commandId))
    .map((row) => ({
      ...row,
      key: `suggested:${row.key}`,
      group: "suggested" as const,
      groupLabel: COPY.groups.suggested,
    }));
  const rest = items.filter((row) => !row.commandId || !SUGGESTED.has(row.commandId));
  return [...suggested, ...rest];
}

function chatRows(input: PaletteInput, query: string): PaletteRow[] {
  const pool = query ? input.sessions : input.sessions.filter((session) => !session.archived);
  const ranked = [...pool].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!query) {
    const pinned = ranked.filter((session) => session.pinned);
    const recent = ranked.filter((session) => !session.pinned).slice(0, RECENT_CHAT_LIMIT);
    return [
      ...pinned.map((session) => chatRow(session, "pinned")),
      ...recent.map((session) => chatRow(session, "recent")),
    ];
  }
  return ranked
    .filter((session) => commandFilter(chatLabel(session.title), query) > 0)
    .map((session) => chatRow(session, "chats"));
}

function chatLabel(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : COPY.untitled;
}

function chatRow(session: PaletteSession, group: "pinned" | "recent" | "chats"): PaletteRow {
  return {
    key: `chat:${session.id}`,
    kind: "chat",
    sessionId: session.id,
    projectId: session.projectId,
    label: chatLabel(session.title),
    group,
    groupLabel: COPY.groups[group],
  };
}

function sortGroups(rows: readonly PaletteRow[]): PaletteRow[] {
  const buckets = new Map<CommandGroup, PaletteRow[]>();
  for (const row of rows) {
    const list = buckets.get(row.group);
    if (list) list.push(row);
    else buckets.set(row.group, [row]);
  }
  const ordered: PaletteRow[] = [];
  for (const group of GROUP_ORDER) {
    const list = buckets.get(group);
    if (list) ordered.push(...list);
  }
  return ordered;
}
