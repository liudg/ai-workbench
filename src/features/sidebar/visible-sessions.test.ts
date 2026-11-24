import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SIDEBAR_VIEW_STATE, sidebarScopeKey, type SidebarViewState } from "./sidebar-view-store.ts";
import type { SidebarTask } from "./sidebar-task.ts";
import { isModStillPressed, isPureModKeyDown } from "./useModHold.ts";
import { computeVisibleSidebarTasks, stepVisibleSidebarTask } from "./visible-sessions.ts";

function makeTask(id: string, projectId: string | null, patch: Partial<SidebarTask> = {}): SidebarTask {
  return {
    id,
    projectId,
    agent: "codex-cli",
    title: id,
    status: "completed",
    attention: { state: "idle", unread: false, updatedAt: 1 },
    updatedAt: 1,
    pinned: false,
    archived: false,
    parentTaskId: null,
    ...patch,
  };
}

test("computeVisibleSidebarTasks matches exact Sidebar order: Pinned projects -> Unpinned projects -> Standalone chats", () => {
  const projects = [
    { id: "p-unpinned-1", pinned: false },
    { id: "p-pinned", pinned: true },
    { id: "p-unpinned-2", pinned: false },
  ];
  const tasks: SidebarTask[] = [
    makeTask("chat-1", null),
    makeTask("u1-archived", "p-unpinned-1", { archived: true }),
    makeTask("u1-1", "p-unpinned-1"),
    makeTask("u1-running", "p-unpinned-1", { status: "running" }),
    makeTask("pin-1", "p-pinned"),
    makeTask("pin-child", "p-pinned", { parentTaskId: "pin-1" }),
    makeTask("u2-1", "p-unpinned-2"),
    makeTask("u2-pinned", "p-unpinned-2", { pinned: true }),
  ];

  const visible = computeVisibleSidebarTasks(projects, tasks, DEFAULT_SIDEBAR_VIEW_STATE);
  assert.deepEqual(
    visible.map((task) => task.id),
    [
      // Pinned project first, with its nested subtask immediately under root
      "pin-1",
      "pin-child",
      // Unpinned project 1: running session promoted before idle session, archived excluded
      "u1-running",
      "u1-1",
      // Unpinned project 2: pinned session promoted before rest
      "u2-pinned",
      "u2-1",
      // Standalone chats last
      "chat-1",
    ],
  );
});

test("computeVisibleSidebarTasks respects collapsedProjects, chatsCollapsed, visibleLimitByScope, and collapsedSubtasks", () => {
  const projects = [
    { id: "p1", pinned: true },
    { id: "p2", pinned: false },
  ];
  const p2Tasks = Array.from({ length: 10 }, (_, idx) => makeTask(`p2-${idx + 1}`, "p2"));
  const tasks: SidebarTask[] = [
    makeTask("p1-root", "p1"),
    makeTask("p1-sub", "p1", { parentTaskId: "p1-root" }),
    ...p2Tasks,
    makeTask("chat-1", null),
  ];

  // Collapse p1's subtasks and chats group; p2 defaults to SESSION_PREVIEW_LIMIT (8)
  const partialView: SidebarViewState = {
    collapsedProjects: new Set(),
    chatsCollapsed: true,
    visibleLimitByScope: {},
    collapsedSubtasks: new Set(["p1-root"]),
  };
  assert.deepEqual(
    computeVisibleSidebarTasks(projects, tasks, partialView).map((t) => t.id),
    ["p1-root", ...p2Tasks.slice(0, 8).map((t) => t.id)],
  );

  // Collapse p1 project and expand p2 scope limit to 16
  const expandedP2: SidebarViewState = {
    collapsedProjects: new Set(["p1"]),
    chatsCollapsed: false,
    visibleLimitByScope: { [sidebarScopeKey("p2")]: 16 },
    collapsedSubtasks: new Set(),
  };
  assert.deepEqual(
    computeVisibleSidebarTasks(projects, tasks, expandedP2).map((t) => t.id),
    [...p2Tasks.map((t) => t.id), "chat-1"],
  );
});

test("stepVisibleSidebarTask cycles prev/next and wraps around cleanly", () => {
  const list = [makeTask("t1", "p"), makeTask("t2", "p"), makeTask("t3", null)];
  assert.equal(stepVisibleSidebarTask([], "t1", 1), null);
  assert.equal(stepVisibleSidebarTask(list, null, 1)?.id, "t1");
  assert.equal(stepVisibleSidebarTask(list, null, -1)?.id, "t3");
  assert.equal(stepVisibleSidebarTask(list, "t1", 1)?.id, "t2");
  assert.equal(stepVisibleSidebarTask(list, "t3", 1)?.id, "t1");
  assert.equal(stepVisibleSidebarTask(list, "t1", -1)?.id, "t3");
});

test("isPureModKeyDown and isModStillPressed check platform-specific Mod key without extra modifiers", () => {
  assert.equal(
    isPureModKeyDown({ key: "Control", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, "windows"),
    true,
  );
  assert.equal(
    isPureModKeyDown({ key: "Control", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, "windows"),
    false,
  );
  assert.equal(
    isPureModKeyDown({ key: "Meta", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }, "mac"),
    true,
  );
  assert.equal(isModStillPressed({ key: "Control", ctrlKey: false, metaKey: false }, "windows"), false);
  assert.equal(isModStillPressed({ key: "Shift", ctrlKey: true, metaKey: false }, "windows"), true);
});
