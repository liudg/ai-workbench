import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isFinishedStatus,
  readUnreadFinishedIds,
  reconcileUnreadFinished,
  sameUnreadIds,
  syncUnreadFinished,
  UNREAD_FINISHED_KEY,
  visibleSessionId,
  writeUnreadFinishedIds,
  type UnreadSession,
  type UnreadSnapshot,
  type UnreadStorage,
} from "./unread-finished.ts";

function groups(sessions: UnreadSession[]): Record<string, UnreadSession[]> {
  return { project: sessions };
}

function session(id: string, status: string): UnreadSession {
  return { id, status };
}

function snap(input: Partial<UnreadSnapshot> & Pick<UnreadSnapshot, "sessions">): UnreadSnapshot {
  return {
    selectedProjectId: "project",
    activeSessionId: {},
    unreadFinishedIds: [],
    ...input,
  };
}

test("finished means completed, failed, or stopped", () => {
  assert.equal(isFinishedStatus("completed"), true);
  assert.equal(isFinishedStatus("failed"), true);
  assert.equal(isFinishedStatus("stopped"), true);
  assert.equal(isFinishedStatus("running"), false);
  assert.equal(isFinishedStatus("needs-input"), false);
  assert.equal(isFinishedStatus(null), false);
  assert.equal(isFinishedStatus(undefined), false);
});

test("only the selected project's active session is open", () => {
  assert.equal(visibleSessionId(null, { project: "codex-cli:a" }), null);
  assert.equal(visibleSessionId("project", {}), null);
  assert.equal(
    visibleSessionId("project", { project: "codex-cli:a", other: "claude-code:b" }),
    "codex-cli:a",
  );
});

test("a finish while the session is not open marks Codex and Claude the same way", () => {
  const ids = reconcileUnreadFinished({
    previousSessions: groups([
      session("codex-cli:run", "running"),
      session("claude-code:wait", "needs-input"),
      session("cursor-agent:run", "running"),
    ]),
    nextSessions: groups([
      session("codex-cli:run", "completed"),
      session("claude-code:wait", "failed"),
      session("cursor-agent:run", "stopped"),
    ]),
    previousUnread: [],
    visibleSessionId: null,
  });
  assert.deepEqual(ids, ["codex-cli:run", "claude-code:wait", "cursor-agent:run"]);
});

test("a finish on the open session does not mark it", () => {
  const ids = reconcileUnreadFinished({
    previousSessions: groups([
      session("codex-cli:open", "running"),
      session("claude-code:away", "running"),
    ]),
    nextSessions: groups([
      session("codex-cli:open", "completed"),
      session("claude-code:away", "completed"),
    ]),
    previousUnread: [],
    visibleSessionId: "codex-cli:open",
  });
  assert.deepEqual(ids, ["claude-code:away"]);
});

test("the first time a finished session is seen, it stays unmarked", () => {
  const ids = reconcileUnreadFinished({
    previousSessions: {},
    nextSessions: groups([
      session("codex-cli:old", "completed"),
      session("claude-code:old", "failed"),
      session("cursor-agent:old", "stopped"),
    ]),
    previousUnread: [],
    visibleSessionId: null,
  });
  assert.deepEqual(ids, []);
});

test("an already finished session keeps its mark across a refresh and does not sort the list", () => {
  const previous = [
    session("codex-cli:b", "completed"),
    session("claude-code:a", "completed"),
  ];
  const next = [
    session("claude-code:a", "completed"),
    session("codex-cli:b", "completed"),
  ];
  const ids = reconcileUnreadFinished({
    previousSessions: groups(previous),
    nextSessions: groups(next),
    previousUnread: ["codex-cli:b"],
    visibleSessionId: null,
  });
  assert.deepEqual(ids, ["codex-cli:b"]);
  assert.deepEqual(next.map((item) => item.id), ["claude-code:a", "codex-cli:b"]);
});

test("opening a session clears only that mark", () => {
  const ids = reconcileUnreadFinished({
    previousSessions: groups([
      session("codex-cli:a", "completed"),
      session("claude-code:b", "failed"),
    ]),
    nextSessions: groups([
      session("codex-cli:a", "completed"),
      session("claude-code:b", "failed"),
    ]),
    previousUnread: ["codex-cli:a", "claude-code:b"],
    visibleSessionId: "codex-cli:a",
  });
  assert.deepEqual(ids, ["claude-code:b"]);
});

test("a session that starts running again drops the mark, then a later finish can mark it", () => {
  const cleared = reconcileUnreadFinished({
    previousSessions: groups([session("codex-cli:a", "completed")]),
    nextSessions: groups([session("codex-cli:a", "running")]),
    previousUnread: ["codex-cli:a"],
    visibleSessionId: null,
  });
  assert.deepEqual(cleared, []);
  const marked = reconcileUnreadFinished({
    previousSessions: groups([session("codex-cli:a", "running")]),
    nextSessions: groups([session("codex-cli:a", "stopped")]),
    previousUnread: cleared,
    visibleSessionId: "claude-code:other",
  });
  assert.deepEqual(marked, ["codex-cli:a"]);
});

test("another project's active session stays marked until that project is open", () => {
  const sessions = {
    a: [session("codex-cli:a", "completed")],
    b: [session("claude-code:b", "completed")],
  };
  const staying = reconcileUnreadFinished({
    previousSessions: sessions,
    nextSessions: sessions,
    previousUnread: ["claude-code:b"],
    visibleSessionId: visibleSessionId("a", { a: "codex-cli:a", b: "claude-code:b" }),
  });
  assert.deepEqual(staying, ["claude-code:b"]);
  const opened = reconcileUnreadFinished({
    previousSessions: sessions,
    nextSessions: sessions,
    previousUnread: staying,
    visibleSessionId: visibleSessionId("b", { a: "codex-cli:a", b: "claude-code:b" }),
  });
  assert.deepEqual(opened, []);
});

test("a deleted session drops its mark; an unloaded id stays", () => {
  const ids = reconcileUnreadFinished({
    previousSessions: groups([session("codex-cli:gone", "completed")]),
    nextSessions: groups([session("claude-code:stay", "completed")]),
    previousUnread: ["codex-cli:gone", "cursor-agent:unloaded"],
    visibleSessionId: null,
  });
  assert.deepEqual(ids, ["cursor-agent:unloaded"]);
});

test("marks cap by dropping the oldest", () => {
  const previousUnread = Array.from({ length: 200 }, (_, index) => `codex-cli:${index}`);
  const ids = reconcileUnreadFinished({
    previousSessions: groups([session("claude-code:new", "running")]),
    nextSessions: groups([session("claude-code:new", "completed")]),
    previousUnread,
    visibleSessionId: null,
  });
  assert.equal(ids.length, 200);
  assert.equal(ids[0], "codex-cli:1");
  assert.equal(ids[ids.length - 1], "claude-code:new");
});

test("sync skips a write when the mark list is unchanged", () => {
  const sessions = groups([session("codex-cli:a", "completed")]);
  const state = snap({ sessions, unreadFinishedIds: ["codex-cli:a"] });
  assert.equal(syncUnreadFinished(state, state), null);
  const finished = syncUnreadFinished(
    snap({
      sessions: groups([session("claude-code:b", "running")]),
      unreadFinishedIds: [],
    }),
    snap({
      sessions: groups([session("claude-code:b", "failed")]),
      unreadFinishedIds: [],
    }),
  );
  assert.deepEqual(finished, ["claude-code:b"]);
});

test("storage round-trips ids and ignores corrupt payloads", () => {
  const saved = new Map<string, string>();
  const storage: UnreadStorage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value);
    },
  };
  writeUnreadFinishedIds(storage, ["codex-cli:a", "claude-code:b"]);
  assert.equal(saved.get(UNREAD_FINISHED_KEY), '["codex-cli:a","claude-code:b"]');
  assert.deepEqual(readUnreadFinishedIds(storage), ["codex-cli:a", "claude-code:b"]);
  saved.set(UNREAD_FINISHED_KEY, "{");
  assert.deepEqual(readUnreadFinishedIds(storage), []);
  saved.set(UNREAD_FINISHED_KEY, '{"id":"codex-cli:a"}');
  assert.deepEqual(readUnreadFinishedIds(storage), []);
  saved.set(
    UNREAD_FINISHED_KEY,
    JSON.stringify(["codex-cli:a", "", "codex-cli:a", 4, "claude-code:b"]),
  );
  assert.deepEqual(readUnreadFinishedIds(storage), ["codex-cli:a", "claude-code:b"]);
  assert.deepEqual(readUnreadFinishedIds(null), []);
  assert.equal(sameUnreadIds(["codex-cli:a"], ["codex-cli:a"]), true);
  assert.equal(sameUnreadIds(["codex-cli:a"], ["claude-code:b"]), false);
});
