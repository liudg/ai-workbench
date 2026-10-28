import { THREAD_FIND_COPY } from "../chat/find/copy.ts";
import { showsFileChanges } from "../changes-model/capabilities.ts";
import type { AgentKind, ChangeCapabilities } from "../../types/index.ts";
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
  | "chats"
  | "files";

export type PaletteCommandId =
  | "new-thread"
  | "new-standalone"
  | "open-folder"
  | "settings"
  | "search-chats"
  | "find-in-thread"
  | "search-files"
  | "archive"
  | "rename"
  | "pin"
  | "fork"
  | "delete"
  | "toggle-files"
  | "toggle-changes"
  | "toggle-sidebar"
  | "quick-open"
  | "board"
  | "next-attention";

export interface PaletteRow {
  key: string;
  kind: "command" | "chat" | "file";
  commandId?: PaletteCommandId;
  sessionId?: string;
  projectId?: string;
  /** 分叉到哪个 Agent。 */
  agent?: AgentKind;
  label: string;
  detail?: string;
  filePath?: string;
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


/** 当前任务能分叉到的 Agent。`same` 是任务现在用的那个。 */
export interface ForkTarget {
  agent: AgentKind;
  name: string;
  same: boolean;
}

export interface PaletteInput {
  query: string;
  mode: "commands" | "chats";
  sessions: readonly PaletteSession[];
  activeSessionId: string | null;
  /** 当前会话的 Agent 声明的变更能力。没有会话时为空。 */
  changes: ChangeCapabilities | undefined;
  canNewThread: boolean;
  canStandalone: boolean;
  canSearchFiles: boolean;
  canFind: boolean;
  forkTargets: readonly ForkTarget[];
  /** 注意力队列里还有下一个等着你的会话。 */
  hasNextAttention: boolean;
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
  "files",
];

const SUGGESTED = new Set<PaletteCommandId>(["new-thread", "open-folder"]);

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
  if (input.canFind) {
    rows.push(command("find-in-thread", THREAD_FIND_COPY.find, "thread", THREAD_FIND_COPY.shortcut));
  }
  // 改名、置顶、归档、删除记在工作台的数据库里，所有 Agent 都有。
  if (active) rows.push(command("rename", COPY.rename, "thread"));
  if (active) rows.push(command("pin", COPY.pin, "thread"));
  if (active) {
    for (const target of input.forkTargets) {
      rows.push({
        ...command("fork", target.same ? COPY.fork : `${COPY.forkTo}${target.name}`, "thread"),
        key: `fork:${target.agent}`,
        agent: target.agent,
      });
    }
  }
  if (active) {
    rows.push(
      command(
        "archive",
        active.archived ? COPY.unarchive : COPY.archive,
        "thread",
      ),
    );
  }
  if (active) rows.push(command("delete", COPY.deleteChat, "thread", COPY.shortcutDelete));
  if (input.hasNextAttention) rows.push(command("next-attention", COPY.nextAttention, "navigation"));
  rows.push(command("board", COPY.board, "navigation"));
  rows.push(command("quick-open", COPY.quickOpen, "navigation", COPY.shortcutQuickOpen));
  rows.push(command("toggle-sidebar", COPY.toggleSidebar, "navigation", COPY.shortcutSidebar));
  if (input.canSearchFiles) rows.push(command("search-files", COPY.searchFiles, "navigation"));
  if (active) rows.push(command("toggle-files", COPY.toggleFiles, "navigation"));
  if (active && showsFileChanges(input.changes)) {
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
