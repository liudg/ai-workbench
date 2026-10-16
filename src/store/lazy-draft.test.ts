import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentInstallation, AgentKind, Session } from "../types/index.ts";
import { draftId, isDraftId } from "./draft-session.ts";
import { landOnEmptyProjectDraft, type LazyDraftState } from "./lazy-draft.ts";
import type { SessionDraft } from "./types.ts";

function installation(kind: AgentKind, linked = true): AgentInstallation {
  return {
    kind,
    display_name: kind,
    installed: true,
    version: null,
    latest_version: null,
    update_available: false,
    update_via: null,
    detail: null,
    session_linked: linked,
  };
}

function session(id: string): Session {
  return {
    id,
    project_id: "p1",
    agent: "claude-code",
    native_id: id,
    title: "已有会话",
    status: "completed",
    created_at: 1,
    updated_at: 1,
    archived: false,
  };
}

function draft(patch: Partial<SessionDraft> = {}): SessionDraft {
  return {
    projectId: "p1",
    agent: "claude-code",
    text: "留下的字",
    sandbox: null,
    tuning: null,
    collaboration: "default",
    goal: null,
    goalStatus: null,
    phase: "idle",
    ...patch,
  };
}

function state(patch: Partial<LazyDraftState> = {}): LazyDraftState {
  return {
    drafts: {},
    draftFocused: {},
    activeSessionId: { p1: "claude-code:old" },
    catalogs: {},
    catalogNotices: {},
    tuning: {},
    sandboxes: {},
    events: {},
    sessions: { p1: [] },
    selectedProjectId: "p1",
    pendingStart: {},
    installations: [installation("codex-cli"), installation("claude-code")],
    preferredAgent: "claude-code",
    projects: [{ id: "p1", default_agent: "codex-cli" }],
    profiles: { "claude-code": { default_access: "ask" } },
    lastSandboxByAgent: {},
    ...patch,
  };
}

test("empty selected project opens a lazy draft for the preferred linked agent", () => {
  const next = landOnEmptyProjectDraft(state(), "p1");
  assert.equal(next?.mode, "focus");
  if (next?.mode !== "focus") return;
  assert.equal(next.value.drafts.p1?.agent, "claude-code");
  assert.equal(next.value.drafts.p1?.text, "");
  assert.equal(isDraftId(draftId("p1")), true);
  assert.equal(next.value.draftFocused.p1, true);
  assert.equal(next.value.activeSessionId.p1, undefined);
  assert.equal(next.value.sandboxes[draftId("p1")]?.mode, "ask");
  assert.equal(next.value.preferredAgent, "claude-code");
});

test("linked agents decide the draft, not an unlinked install listed first", () => {
  const next = landOnEmptyProjectDraft(
    state({
      installations: [installation("cursor-agent", false), installation("codex-cli", true)],
      preferredAgent: null,
      profiles: {},
    }),
    "p1",
  );
  assert.equal(next?.mode, "focus");
  if (next?.mode !== "focus") return;
  assert.equal(next.value.drafts.p1?.agent, "codex-cli");
});

test("an existing unfocused draft keeps its text and agent", () => {
  const next = landOnEmptyProjectDraft(
    state({
      drafts: { p1: draft({ agent: "codex-cli", text: "别丢" }) },
      draftFocused: { p1: false },
      preferredAgent: "claude-code",
    }),
    "p1",
  );
  assert.equal(next?.mode, "focus");
  if (next?.mode !== "focus") return;
  assert.equal(next.value.drafts.p1?.text, "别丢");
  assert.equal(next.value.drafts.p1?.agent, "codex-cli");
  assert.equal(next.value.draftFocused.p1, true);
});

test("a draft that is already open is left alone", () => {
  const current = state({
    drafts: { p1: draft() },
    draftFocused: { p1: true },
  });
  assert.equal(landOnEmptyProjectDraft(current, "p1"), null);
});

test("sessions still in the project do not open a draft", () => {
  assert.equal(
    landOnEmptyProjectDraft(state({ sessions: { p1: [session("claude-code:keep")] } }), "p1"),
    null,
  );
});

test("a list that has not loaded is not treated as empty", () => {
  assert.equal(landOnEmptyProjectDraft(state({ sessions: {} }), "p1"), null);
});

test("another project's empty list does not steal the current view", () => {
  assert.equal(
    landOnEmptyProjectDraft(
      state({ selectedProjectId: "p2", sessions: { p1: [], p2: [session("codex-cli:live")] } }),
      "p1",
    ),
    null,
  );
});

test("no linked agent means no draft", () => {
  assert.equal(
    landOnEmptyProjectDraft(state({ installations: [], preferredAgent: null, drafts: {} }), "p1"),
    null,
  );
});

test("before installations load, the project default agent opens the draft", () => {
  const next = landOnEmptyProjectDraft(
    state({ installations: null, preferredAgent: null, profiles: {} }),
    "p1",
  );
  assert.equal(next?.mode, "focus");
  if (next?.mode !== "focus") return;
  assert.equal(next.value.drafts.p1?.agent, "codex-cli");
});

test("a create in flight only focuses the draft that is already claimed", () => {
  const creating = draft({ phase: "creating", text: "发出去" });
  const next = landOnEmptyProjectDraft(
    state({
      drafts: { p1: creating },
      draftFocused: {},
      pendingStart: { p1: { agent: "claude-code", title: "发出去", at: 1 } },
    }),
    "p1",
  );
  assert.deepEqual(next, { mode: "reveal", draftFocused: { p1: true } });
});
