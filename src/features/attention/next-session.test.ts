import assert from "node:assert/strict";
import { test } from "node:test";

import type { Project, Session, SessionEvent, SessionEventBody, SessionStatus } from "../../types/index.ts";
import {
  attentionSessionOrder,
  nextAttentionTarget,
  sessionNeedsAttention,
} from "./next-session.ts";

function project(id: string, standalone = false): Project {
  return {
    id,
    name: id,
    path: `/${id}`,
    default_agent: "codex-cli",
    created_at: 1,
    updated_at: 1,
    standalone,
  };
}

function session(
  projectId: string,
  id: string,
  status: SessionStatus,
  extra: Partial<Session> = {},
): Session {
  return {
    id,
    project_id: projectId,
    agent: "codex-cli",
    native_id: id,
    title: id,
    status,
    created_at: 1,
    updated_at: extra.updated_at ?? 1,
    ...extra,
  };
}

function event(id: string, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq: 1, ts: 1, ...body };
}

function approval(id: string): SessionEvent {
  return event(id, {
    kind: "prompt",
    prompt_id: id,
    prompt_kind: "approval",
    question: "允许运行？",
    options: [],
    questions: [],
  });
}

function question(id: string): SessionEvent {
  return event(id, {
    kind: "prompt",
    prompt_id: id,
    prompt_kind: "questions",
    question: "选哪个？",
    options: [],
    questions: [{ id: "q", question: "选哪个？", is_secret: false, options: [] }],
  });
}

test("attention is unread, pending approval, or a pending question", () => {
  assert.equal(
    sessionNeedsAttention({
      status: "completed",
      unreadFinished: true,
      events: [],
      eventsReady: true,
    }),
    true,
  );
  assert.equal(
    sessionNeedsAttention({
      status: "needs-input",
      unreadFinished: false,
      events: [approval("a")],
      eventsReady: true,
    }),
    true,
  );
  assert.equal(
    sessionNeedsAttention({
      status: "needs-input",
      unreadFinished: false,
      events: [question("q")],
      eventsReady: true,
    }),
    true,
  );
  assert.equal(
    sessionNeedsAttention({
      status: "running",
      unreadFinished: false,
      events: [approval("a")],
      eventsReady: true,
    }),
    true,
  );
  assert.equal(
    sessionNeedsAttention({
      status: "needs-input",
      unreadFinished: false,
      events: undefined,
      eventsReady: false,
    }),
    true,
  );
});

test("a loaded elicitation does not count, and a running chat is not unread", () => {
  const elicitation = event("e", {
    kind: "prompt",
    prompt_id: "e",
    prompt_kind: "elicitation",
    question: "填一下",
    options: [],
    questions: [],
  });
  assert.equal(
    sessionNeedsAttention({
      status: "needs-input",
      unreadFinished: false,
      events: [elicitation],
      eventsReady: true,
    }),
    false,
  );
  assert.equal(
    sessionNeedsAttention({
      status: "running",
      unreadFinished: true,
      events: [],
      eventsReady: true,
    }),
    false,
  );
  assert.equal(
    sessionNeedsAttention({
      status: "completed",
      unreadFinished: false,
      events: [],
      eventsReady: true,
    }),
    false,
  );
});

test("next attention follows sidebar order, skips the current chat, and wraps", () => {
  const projects = [project("plain"), project("pinned"), project("chat", true)];
  const sessions = {
    plain: [
      session("plain", "idle", "completed"),
      session("plain", "approve", "needs-input"),
      session("plain", "old", "completed", { archived: true }),
    ],
    pinned: [session("pinned", "pin-idle", "completed")],
    chat: [session("chat", "unread", "completed", { updated_at: 5 })],
  };
  const order = attentionSessionOrder({
    projects,
    pinnedProjectIds: ["pinned"],
    sessions,
    pinnedSessionIds: [],
  });
  assert.deepEqual(
    order.map((item) => item.id),
    ["pin-idle", "approve", "idle", "unread"],
  );

  const base = {
    projects,
    pinnedProjectIds: ["pinned"],
    sessions,
    pinnedSessionIds: [],
    events: {
      approve: [approval("card")],
    },
    eventsReady: { approve: true, idle: true, "pin-idle": true, unread: true },
    unreadFinishedIds: ["unread"],
    currentId: "idle",
  };
  assert.equal(nextAttentionTarget(base)?.id, "unread");
  assert.equal(nextAttentionTarget({ ...base, currentId: "unread" })?.id, "approve");
  assert.equal(nextAttentionTarget({ ...base, currentId: "approve" })?.id, "unread");
  assert.equal(
    nextAttentionTarget({
      ...base,
      currentId: "approve",
      unreadFinishedIds: [],
      events: {},
      eventsReady: { approve: true },
    }),
    null,
  );
});

test("a question waiting in another project is the next chat", () => {
  const projects = [project("a"), project("b")];
  const sessions = {
    a: [session("a", "here", "completed")],
    b: [session("b", "ask", "needs-input")],
  };
  const target = nextAttentionTarget({
    projects,
    pinnedProjectIds: [],
    sessions,
    pinnedSessionIds: [],
    events: { ask: [question("q")], here: [] },
    eventsReady: { ask: true, here: true },
    unreadFinishedIds: [],
    currentId: "here",
  });
  assert.deepEqual(target, { id: "ask", projectId: "b" });
});
