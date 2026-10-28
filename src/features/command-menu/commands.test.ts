import assert from "node:assert/strict";
import { test } from "node:test";

import { THREAD_FIND_COPY } from "../chat/find/copy.ts";
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
  assert.equal(rows.find((row) => row.commandId === "toggle-sidebar")?.shortcut, COPY.shortcutSidebar);
  assert.equal(rows.find((row) => row.commandId === "quick-open")?.label, COPY.quickOpen);
  assert.equal(rows.find((row) => row.commandId === "quick-open")?.shortcut, COPY.shortcutQuickOpen);
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

test("fork rows follow the task's fork targets, one per agent", () => {
  const rows = buildPaletteRows({
    ...enabled,
    forkTargets: [
      { agent: "codex-cli", name: "Codex", same: true },
      { agent: "claude-code", name: "Claude Code", same: false },
    ],
  });
  const forks = rows.filter((row) => row.commandId === "fork");
  assert.deepEqual(
    forks.map((row) => [row.label, row.agent, row.key]),
    [
      [COPY.fork, "codex-cli", "fork:codex-cli"],
      [`${COPY.forkTo}Claude Code`, "claude-code", "fork:claude-code"],
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
  assert.equal(next?.label, "下一个需要处理的聊天");
  assert.equal(next?.group, "navigation");
});
