import assert from "node:assert/strict";
import { test } from "node:test";

import { THREAD_FIND_COPY } from "../chat/find/copy.ts";
import type { AgentInstallation, AgentKind } from "../../types/index.ts";
import { COMMAND_MENU_COPY as COPY } from "./copy.ts";
import {
  buildPaletteRows,
  RECENT_CHAT_LIMIT,
  resolveCommandAgent,
  type PaletteInput,
  type PaletteSession,
} from "./commands.ts";

function install(kind: AgentKind, linked = true): AgentInstallation {
  return {
    kind,
    display_name: kind,
    installed: true,
    version: "1",
    latest_version: null,
    update_available: false,
    update_via: null,
    detail: null,
    session_linked: linked,
  };
}

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
  caps: {
    supports_archive: true,
    supports_rename: true,
    supports_delete: true,
    supports_fork: true,
    changes: { turn_diff: true, per_file_patch: true, git_scopes: true },
  },
  canNewThread: true,
  canStandalone: true,
  canSearchFiles: true,
  canFind: true,
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

test("capability flags hide commands without reading an agent name", () => {
  const hidden = ids({
    ...enabled,
    caps: {
      supports_archive: false,
      supports_rename: false,
      supports_delete: false,
      supports_fork: false,
      changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
    },
  });
  assert.equal(hidden.includes("archive"), false);
  assert.equal(hidden.includes("rename"), false);
  assert.equal(hidden.includes("delete"), false);
  assert.equal(hidden.includes("fork"), false);
  assert.equal(hidden.includes("toggle-changes"), false);
  assert.equal(hidden.includes("pin"), true);
  assert.equal(hidden.includes("toggle-files"), true);
});

test("unknown caps keep the changes command and hold archive until the flag is true", () => {
  const rows = ids({ ...enabled, caps: null });
  assert.equal(rows.includes("toggle-changes"), true);
  assert.equal(rows.includes("archive"), false);
  assert.equal(rows.includes("pin"), true);
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

test("find stays behind the open chat, and the next-attention command does not", () => {
  const withChat = ids(enabled);
  assert.equal(withChat.includes("find-in-thread"), true);
  assert.equal(withChat.includes("next-attention"), true);
  assert.equal(
    buildPaletteRows(enabled).find((row) => row.commandId === "find-in-thread")?.shortcut,
    THREAD_FIND_COPY.shortcut,
  );
  const hidden = ids({ ...enabled, canFind: false });
  assert.equal(hidden.includes("find-in-thread"), false);
  assert.equal(hidden.includes("next-attention"), true);
  const found = buildPaletteRows({ ...enabled, query: "查找" });
  assert.equal(found.some((row) => row.commandId === "find-in-thread"), true);
  const next = buildPaletteRows({ ...enabled, query: "下一个需要处理" });
  assert.equal(next.some((row) => row.commandId === "next-attention"), true);
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

test("new chat agent comes from the usable installation list", () => {
  const alien = "not-registered" as AgentKind;
  assert.equal(
    resolveCommandAgent({
      installations: [install(alien)],
      activeAgent: "codex-cli",
      projectDefault: "claude-code",
      preferred: "cursor-agent",
    }),
    alien,
  );
  assert.equal(
    resolveCommandAgent({
      installations: [install("codex-cli"), install("claude-code")],
      activeAgent: "claude-code",
      projectDefault: "codex-cli",
      preferred: "codex-cli",
    }),
    "claude-code",
  );
  assert.equal(
    resolveCommandAgent({
      installations: [install("codex-cli"), install("claude-code")],
      activeAgent: "codex-cli",
      projectDefault: "claude-code",
      preferred: "claude-code",
    }),
    "codex-cli",
  );
  assert.equal(
    resolveCommandAgent({
      installations: [install("claude-code", false)],
      activeAgent: null,
      projectDefault: null,
      preferred: null,
    }),
    null,
  );
});
