import assert from "node:assert/strict";
import { test } from "node:test";

import { THREAD_FIND_COPY } from "../chat/headless.ts";
import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  formatCommandShortcut,
  resolveKeybindings,
} from "../../shared/keybindings/defaults.ts";
import { COMMAND_MENU_COPY as COPY } from "./copy.ts";
import {
  buildPaletteRows,
  RECENT_CHAT_LIMIT,
  type PaletteInput,
  type PaletteSession,
} from "./commands.ts";

function session(id: string, title: string, updatedAt: number, extra: Partial<PaletteSession> = {}): PaletteSession {
  return {
    id,
    projectId: "p",
    title,
    archived: false,
    updatedAt,
    pinned: false,
    ...extra,
  };
}

const enabled: PaletteInput = {
  query: "",
  mode: "commands",
  sessions: [session("s", "当前", 1)],
  activeSessionId: "s",
  changes: { turn_diff: true, per_file_patch: true, git_scopes: true },
  canNewThread: true,
  canStandalone: true,
  canSearchFiles: true,
  canCheckUpdates: true,
  hasPanel: true,
  canSideChat: false,
  canFind: true,
  forkTargets: [],
  hasNextAttention: false,
};

function ids(input: PaletteInput) {
  return buildPaletteRows(input).map((row) => row.commandId ?? row.sessionId);
}

test("empty query lifts new chat and open folder into 快捷操作", () => {
  const rows = buildPaletteRows(enabled);
  assert.equal(rows[0]?.label, COPY.newThread);
  assert.equal(rows[0]?.groupLabel, COPY.groups.suggested);
  assert.equal(rows[1]?.label, COPY.openFolder);
  assert.equal(rows[1]?.groupLabel, COPY.groups.suggested);
  assert.equal(rows.filter((row) => row.label === COPY.newThread).length, 1);
  assert.equal(rows.find((row) => row.commandId === "settings")?.groupLabel, COPY.groups.settings);
  assert.equal(rows.find((row) => row.commandId === "check-updates")?.label, COPY.checkUpdates);
  assert.equal(rows.find((row) => row.commandId === "check-updates")?.groupLabel, COPY.groups.settings);
  assert.ok(rows.findIndex((row) => row.group === "settings") < rows.findIndex((row) => row.group === "thread"));
});

test("sidebar and file jump stay available without a session", () => {
  const rows = buildPaletteRows({
    ...enabled,
    changes: undefined,
    activeSessionId: null,
    canNewThread: false,
    canStandalone: false,
    canSearchFiles: false,
  });
  assert.equal(rows.find((row) => row.commandId === "toggle-sidebar")?.label, COPY.toggleSidebar);
  assert.equal(
    rows.find((row) => row.commandId === "toggle-sidebar")?.shortcut,
    formatCommandShortcut("sidebar.toggle", DEFAULT_RESOLVED_KEYBINDINGS),
  );
  assert.equal(rows.find((row) => row.commandId === "quick-open")?.label, COPY.quickOpen);
  assert.equal(
    rows.find((row) => row.commandId === "quick-open")?.shortcut,
    formatCommandShortcut("quickOpen.toggle", DEFAULT_RESOLVED_KEYBINDINGS),
  );
});

test("every open session gets rename, pin, archive and delete; changes follow the capability", () => {
  const rows = ids({ ...enabled, changes: { turn_diff: false, per_file_patch: false, git_scopes: false } });
  for (const id of ["rename", "pin", "archive", "delete", "toggle-files"]) assert.equal(rows.includes(id), true, id);
  assert.equal(rows.includes("toggle-changes"), false);
  const none = ids({ ...enabled, activeSessionId: null });
  for (const id of ["rename", "pin", "archive", "delete"]) assert.equal(none.includes(id), false, id);
});

test("unknown changes capability keeps the changes command", () => {
  assert.equal(ids({ ...enabled, changes: undefined }).includes("toggle-changes"), true);
});

test("archived sessions leave the recent list and stay searchable", () => {
  const sessions = [
    session("old", "归档过的", 9, { archived: true }),
    session("pin", "置顶", 8, { pinned: true }),
    ...Array.from({ length: RECENT_CHAT_LIMIT + 2 }, (_, index) =>
      session(`r${index}`, `聊天${index}`, index),
    ),
  ];
  const rows = buildPaletteRows({ ...enabled, sessions, activeSessionId: "pin" });
  const recent = rows.filter((row) => row.group === "recent");
  assert.equal(recent.length, RECENT_CHAT_LIMIT);
  assert.equal(recent.some((row) => row.sessionId === "old"), false);
  assert.equal(rows.some((row) => row.group === "pinned" && row.sessionId === "pin"), true);
  const found = buildPaletteRows({ ...enabled, sessions, query: "归档" });
  assert.equal(found.some((row) => row.sessionId === "old" && row.group === "chats"), true);
});

test("find stays behind the open chat", () => {
  const withChat = ids(enabled);
  assert.equal(withChat.includes("find-in-thread"), true);
  assert.equal(
    buildPaletteRows(enabled).find((row) => row.commandId === "find-in-thread")?.shortcut,
    THREAD_FIND_COPY.shortcut,
  );
  const hidden = ids({ ...enabled, canFind: false });
  assert.equal(hidden.includes("find-in-thread"), false);
  const found = buildPaletteRows({ ...enabled, query: "查找" });
  assert.equal(found.some((row) => row.commandId === "find-in-thread"), true);
});

test("blank titles use the observed untitled label", () => {
  const rows = buildPaletteRows({
    ...enabled,
    sessions: [session("blank", "  ", 2)],
    activeSessionId: "blank",
  });
  assert.equal(rows.find((row) => row.sessionId === "blank")?.label, COPY.untitled);
});

test("a query drops the shortcut group and zero scores", () => {
  const rows = buildPaletteRows({ ...enabled, query: "zzz" });
  assert.equal(rows.some((row) => row.group === "suggested"), false);
  assert.equal(rows.length, 0);
  const settings = buildPaletteRows({ ...enabled, query: "设置" });
  assert.equal(settings.some((row) => row.commandId === "settings"), true);
  assert.equal(settings.some((row) => row.group === "suggested"), false);
});

test("fork rows follow the task's fork targets, including multiple instances of the same AgentKind", () => {
  const rows = buildPaletteRows({
    ...enabled,
    forkTargets: [
      { agent: "codex-cli", name: "Codex", same: true },
      { agent: "codex-cli", instanceId: "codex-work", name: "Codex 工作网关", same: false },
      { agent: "claude-code", name: "Claude Code", same: false },
    ],
  });
  const forks = rows.filter((row) => row.commandId === "fork");
  assert.deepEqual(
    forks.map((row) => [row.label, row.agent, row.instanceId, row.key]),
    [
      [COPY.fork, "codex-cli", undefined, "fork:codex-cli"],
      [`${COPY.forkTo}Codex 工作网关`, "codex-cli", "codex-work", "fork:codex-work"],
      [`${COPY.forkTo}Claude Code`, "claude-code", undefined, "fork:claude-code"],
    ],
  );
  assert.equal(ids({ ...enabled, activeSessionId: null, forkTargets: [{ agent: "codex-cli", name: "Codex", same: true }] }).includes("fork"), false);
  assert.equal(ids(enabled).includes("fork"), false);
});

test("the board is always reachable; next-in-queue only when someone is waiting", () => {
  assert.equal(ids(enabled).includes("board"), true);
  assert.equal(ids(enabled).includes("next-attention"), false);
  const waiting = buildPaletteRows({ ...enabled, hasNextAttention: true });
  const next = waiting.find((row) => row.commandId === "next-attention");
  assert.equal(next?.label, "下一个需要处理的对话");
  assert.equal(next?.group, "navigation");
});

test("the terminal toggle follows the panel, not the active chat", () => {
  const draft = buildPaletteRows({ ...enabled, activeSessionId: null, hasPanel: true });
  assert.equal(
    draft.find((row) => row.commandId === "toggle-terminal")?.shortcut,
    formatCommandShortcut("terminal.toggle", DEFAULT_RESOLVED_KEYBINDINGS),
  );
  const none = buildPaletteRows({ ...enabled, activeSessionId: null, hasPanel: false });
  assert.equal(none.some((row) => row.commandId === "toggle-terminal"), false);
});

test("the side chat toggle shows only when the chat can open one", () => {
  const off = buildPaletteRows(enabled);
  assert.equal(off.some((row) => row.commandId === "toggle-side-chat"), false);
  const on = buildPaletteRows({ ...enabled, canSideChat: true });
  assert.equal(
    on.find((row) => row.commandId === "toggle-side-chat")?.shortcut,
    formatCommandShortcut("sideChat.toggle", DEFAULT_RESOLVED_KEYBINDINGS),
  );
});

test("check-updates only appears when desktop updater is supported", () => {
  assert.equal(ids(enabled).includes("check-updates"), true);
  assert.equal(ids({ ...enabled, canCheckUpdates: false }).includes("check-updates"), false);
});

test("palette rows reflect live customized and unbound keybindings and include session prev/next", () => {
  const custom = resolveKeybindings(
    DEFAULT_KEYBINDINGS,
    [
      { command: "sidebar.toggle", key: "" },
      { command: "board.toggle", key: "mod+shift+b" },
    ],
    "windows",
  );
  const rows = buildPaletteRows({ ...enabled, keybindings: custom, platform: "windows" });
  assert.equal(rows.find((row) => row.commandId === "toggle-sidebar")?.shortcut, undefined);
  assert.equal(rows.find((row) => row.commandId === "board")?.shortcut, "Ctrl+Shift+B");
  assert.equal(rows.find((row) => row.commandId === "prev-session")?.shortcut, "Ctrl+Shift+[");
  assert.equal(rows.find((row) => row.commandId === "next-session")?.shortcut, "Ctrl+Shift+]");

  const collapsedAll = buildPaletteRows({ ...enabled, canSwitchSession: false });
  assert.equal(collapsedAll.some((row) => row.commandId === "prev-session"), false);
  assert.equal(collapsedAll.some((row) => row.commandId === "next-session"), false);
});

test("full-text searchHits add 会话正文命中 rows, deduplicate title hits already in chats, and resolve project/role metadata", () => {
  const sessions = [
    session("t1", "修登录跳转", 10, { projectId: "p1" }),
    session("t2", "数据库迁移", 9, { projectId: "p1" }),
    session("t3", "独立备忘", 8, { projectId: "", archived: true }),
  ];
  const rows = buildPaletteRows({
    ...enabled,
    query: "登录",
    sessions,
    projects: [{ id: "p1", name: "核心工作台" }],
    searchHits: [
      // t1 title already matched in `chats` -> deduplicated
      {
        taskId: "t1",
        projectId: "p1",
        taskTitle: "修登录跳转",
        role: "title",
        snippet: "修登录跳转",
        ts: 10,
      },
      // t2 body hit -> shown in 会话正文命中 with eventId
      {
        taskId: "t2",
        projectId: "p1",
        taskTitle: "数据库迁移",
        sessionId: "s2",
        eventId: "ev-42",
        seq: 42,
        role: "assistant",
        snippet: "…迁移后修复了登录 token 校验…",
        ts: 9,
      },
      // t3 standalone archived user hit -> shown with 聊天 + archived
      {
        taskId: "t3",
        taskTitle: "独立备忘",
        archivedAt: 100,
        sessionId: "s3",
        eventId: "ev-7",
        seq: 7,
        role: "user",
        snippet: "记录一下登录配置",
        ts: 8,
      },
    ],
  });

  const chatMatches = rows.filter((row) => row.group === "chats");
  assert.deepEqual(chatMatches.map((row) => row.sessionId), ["t1"]);

  const messageMatches = rows.filter((row) => row.group === "messages");
  assert.equal(messageMatches.length, 2);
  assert.equal(messageMatches[0]?.groupLabel, "会话正文命中");
  assert.equal(messageMatches[0]?.sessionId, "t2");
  assert.equal(messageMatches[0]?.eventId, "ev-42");
  assert.equal(messageMatches[0]?.projectName, "核心工作台");
  assert.equal(messageMatches[0]?.roleLabel, "助手");
  assert.equal(messageMatches[0]?.archived, false);

  assert.equal(messageMatches[1]?.sessionId, "t3");
  assert.equal(messageMatches[1]?.eventId, "ev-7");
  assert.equal(messageMatches[1]?.projectName, "聊天");
  assert.equal(messageMatches[1]?.roleLabel, "用户");
  assert.equal(messageMatches[1]?.archived, true);
});
