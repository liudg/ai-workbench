import assert from "node:assert/strict";
import { test } from "node:test";

import type { TaskEntry } from "@/features/tasks";
import type { AgentProfile, SessionEvent } from "@/types";
import { canOpenSideChat } from "./can-open.ts";

const profile = { capabilities: { supports_side_chat: true } } as unknown as AgentProfile;
const task = (nativeId?: string) => ({ sessions: [{ id: "s", nativeId }] }) as unknown as TaskEntry;
const events = (...items: object[]) => items as unknown as SessionEvent[];
const spoke = { kind: "user-message", text: "修登录" };

test("the main thread must have spoken in its own native session", () => {
  assert.equal(canOpenSideChat(task("thread-1"), profile, events(spoke)), true);
  // Codex 起线程时就有 id，第一条消息前还没有 rollout。
  assert.equal(canOpenSideChat(task("thread-1"), profile, events()), false);
  assert.equal(canOpenSideChat(task(), profile, events(spoke)), false);
  const cursor = { capabilities: { supports_side_chat: false } } as unknown as AgentProfile;
  assert.equal(canOpenSideChat(task("thread-1"), cursor, events(spoke)), false);
});

test("context handed over from another agent has to be delivered first", () => {
  // 换回用过的 Agent：接回原线程，但前文还没交出去。
  const pending = { kind: "handoff", delivered: false };
  assert.equal(canOpenSideChat(task("thread-1"), profile, events(pending)), false);
  assert.equal(canOpenSideChat(task("thread-1"), profile, events({ ...pending, delivered: true }, spoke)), true);
});
