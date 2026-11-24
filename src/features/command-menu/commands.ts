import { showsFileChanges } from "../changes-model/index.ts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  formatCommandShortcut,
} from "../../shared/keybindings/defaults.ts";
import type { ResolvedKeybindingRule, ShortcutPlatform } from "../../shared/keybindings/types.ts";
import { resolveSearchProjectName, searchHitRoleLabel } from "../../shared/search/snippet.ts";
import type { AgentKind, ChangeCapabilities } from "../../types/index.ts";
import type { ForkTarget, TaskSearchHit } from "../tasks/index.ts";
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
  | "messages"
  | "files";

export type PaletteCommandId =
  | "new-thread"
  | "new-standalone"
  | "open-folder"
  | "settings"
  | "check-updates"
  | "toggle-theme"
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
  | "toggle-terminal"
  | "toggle-side-chat"
  | "toggle-sidebar"
  | "quick-open"
  | "board"
  | "next-attention"
  | "prev-session"
  | "next-session";

export const PALETTE_KEYBINDING_IDS: Partial<Record<PaletteCommandId, string>> = {
  "new-thread": "session.new",
  "new-standalone": "session.newStandalone",
  "open-folder": "project.openFolder",
  settings: "settings.open",
  "toggle-theme": "theme.toggle",
  "find-in-thread": "chat.find",
  "search-files": "files.search",
  delete: "session.delete",
  "toggle-files": "panel.toggleFiles",
  "toggle-changes": "panel.toggleChanges",
  "toggle-terminal": "terminal.toggle",
  "toggle-side-chat": "sideChat.toggle",
  "toggle-sidebar": "sidebar.toggle",
  "quick-open": "quickOpen.toggle",
  board: "board.toggle",
  "next-attention": "session.nextAttention",
  "prev-session": "session.prev",
  "next-session": "session.next",
};

export interface PaletteRow {
  key: string;
  kind: "command" | "chat" | "message" | "file";
  commandId?: PaletteCommandId;
  sessionId?: string;
  projectId?: string;
  eventId?: string;
  roleLabel?: string;
  projectName?: string;
  archived?: boolean;
  snippet?: string;
  /** 分叉到哪个 Agent / 实例。 */
  agent?: AgentKind;
  instanceId?: string;
  label: string;
  detail?: string;
  filePath?: string;
  group: CommandGroup;
  groupLabel: string;
  shortcut?: string;
}

export interface PaletteProjectSummary {
  id: string;
  name: string;
}

export interface PaletteSession {
  id: string;
  projectId: string;
  title: string;
  archived: boolean;
  updatedAt: number;
  pinned: boolean;
}

export interface PaletteInput {
  query: string;
  mode: "commands" | "chats";
  sessions: readonly PaletteSession[];
  projects?: readonly PaletteProjectSummary[];
  searchHits?: readonly TaskSearchHit[];
  activeSessionId: string | null;
  /** 当前会话的 Agent 声明的变更能力。没有会话时为空。 */
  changes: ChangeCapabilities | undefined;
  canNewThread: boolean;
  canStandalone: boolean;
  canSearchFiles: boolean;
  canCheckUpdates: boolean;
  /** 有右侧面板（建好的会话或项目里的新会话）。 */
  hasPanel: boolean;
  /** 当前会话能开侧边聊天。 */
  canSideChat: boolean;
  canFind: boolean;
  forkTargets: readonly ForkTarget[];
  /** 注意力队列里还有下一个等着你的会话。 */
  hasNextAttention: boolean;
  /** 当前侧边栏可见会话非空时允许切换上/下一条会话。缺省按未归档会话判断。 */
  canSwitchSession?: boolean;
  /** 当前生效的快捷键列表（传入后命令菜单展示实时自定义快捷键）。 */
  keybindings?: readonly ResolvedKeybindingRule[];
  platform?: ShortcutPlatform;
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
  "messages",
  "files",
];

const SUGGESTED = new Set<PaletteCommandId>(["new-thread", "open-folder"]);

export function buildPaletteRows(input: PaletteInput): PaletteRow[] {
  const query = input.query.trim();
  const chats = chatRows(input, query);
  const messages = query ? messageHitRows(input, chats) : [];
  if (input.mode === "chats") return sortGroups([...chats, ...messages]);
  const items = commandItems(input);
  const commands = query
    ? items.filter((row) => commandFilter(row.label, query) > 0)
    : placeSuggested(items);
  return sortGroups([...commands, ...chats, ...messages]);
}

function commandItems(input: PaletteInput): PaletteRow[] {
  const active = input.sessions.find((session) => session.id === input.activeSessionId) ?? null;
  const rules = input.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const shortcutFor = (id: PaletteCommandId): string | undefined => {
    const bindingId = PALETTE_KEYBINDING_IDS[id];
    if (!bindingId) return undefined;
    return formatCommandShortcut(bindingId, rules, input.platform);
  };
  const cmd = (id: PaletteCommandId, label: string, group: CommandGroup) =>
    command(id, label, group, shortcutFor(id));

  const rows: PaletteRow[] = [];
  if (input.canNewThread) rows.push(cmd("new-thread", COPY.newThread, "thread"));
  if (input.canStandalone) rows.push(cmd("new-standalone", COPY.newStandalone, "thread"));
  rows.push(cmd("search-chats", COPY.searchChats, "thread"));
  if (input.canFind) {
    rows.push(cmd("find-in-thread", COPY.findInThread, "thread"));
  }
  // 改名、置顶、归档、删除记在工作台的数据库里，所有 Agent 都有。
  if (active) rows.push(cmd("rename", COPY.rename, "thread"));
  if (active) rows.push(cmd("pin", COPY.pin, "thread"));
  if (active) {
    for (const target of input.forkTargets) {
      rows.push({
        ...cmd("fork", target.same ? COPY.fork : `${COPY.forkTo}${target.name}`, "thread"),
        key: `fork:${target.instanceId ?? target.agent}`,
        agent: target.agent,
        ...(target.instanceId ? { instanceId: target.instanceId } : {}),
      });
    }
  }
  if (active) {
    rows.push(cmd("archive", active.archived ? COPY.unarchive : COPY.archive, "thread"));
  }
  if (active) rows.push(cmd("delete", COPY.deleteChat, "thread"));
  if (input.hasNextAttention) rows.push(cmd("next-attention", COPY.nextAttention, "navigation"));
  const canSwitch = input.canSwitchSession ?? input.sessions.some((session) => !session.archived);
  if (canSwitch) {
    rows.push(cmd("prev-session", COPY.prevSession, "navigation"));
    rows.push(cmd("next-session", COPY.nextSession, "navigation"));
  }
  rows.push(cmd("board", COPY.board, "navigation"));
  rows.push(cmd("quick-open", COPY.quickOpen, "navigation"));
  rows.push(cmd("toggle-sidebar", COPY.toggleSidebar, "navigation"));
  if (input.canSearchFiles) rows.push(cmd("search-files", COPY.searchFiles, "navigation"));
  if (active) rows.push(cmd("toggle-files", COPY.toggleFiles, "navigation"));
  if (active && showsFileChanges(input.changes)) {
    rows.push(cmd("toggle-changes", COPY.toggleChanges, "panels"));
  }
  if (input.hasPanel) rows.push(cmd("toggle-terminal", COPY.toggleTerminal, "panels"));
  if (input.canSideChat) {
    rows.push(cmd("toggle-side-chat", COPY.toggleSideChat, "panels"));
  }
  rows.push(cmd("open-folder", COPY.openFolder, "workspace"));
  rows.push(cmd("toggle-theme", COPY.toggleTheme, "settings"));
  rows.push(cmd("settings", COPY.settings, "settings"));
  if (input.canCheckUpdates) {
    rows.push(cmd("check-updates", COPY.checkUpdates, "settings"));
  }
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

function messageHitRows(input: PaletteInput, existingChats: readonly PaletteRow[]): PaletteRow[] {
  const hits = input.searchHits;
  if (!hits || hits.length === 0) return [];
  const matchedTitleIds = new Set(existingChats.map((row) => row.sessionId).filter(Boolean));
  const rows: PaletteRow[] = [];
  for (const hit of hits) {
    if (hit.role === "title" && matchedTitleIds.has(hit.taskId)) {
      continue;
    }
    const label = chatLabel(hit.taskTitle);
    const trimmedSnippet = hit.snippet.trim();
    const snippet =
      hit.role === "title" || trimmedSnippet.length === 0 || trimmedSnippet === label.trim()
        ? undefined
        : hit.snippet;
    rows.push({
      key: `message:${hit.taskId}:${hit.role}:${hit.eventId ?? hit.seq ?? 0}`,
      kind: "message",
      sessionId: hit.taskId,
      projectId: hit.projectId ?? "",
      eventId: hit.eventId,
      roleLabel: searchHitRoleLabel(hit.role),
      projectName: resolveSearchProjectName(hit.projectId, input.projects ?? []),
      archived: hit.archivedAt != null,
      snippet,
      label,
      group: "messages",
      groupLabel: COPY.groups.messages,
    });
  }
  return rows;
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
