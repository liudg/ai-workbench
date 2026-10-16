import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "@/types";
import { draftId, type DraftCarryState } from "./draft-session.ts";
import {
  adoptCreatedChat,
  composerShowsWorkContext,
  keepSelectedProjectId,
  projectStillListed,
  retargetStandaloneDraft,
  standaloneChatSessions,
  STANDALONE_DRAFT_ID,
  visibleProjects,
} from "./standalone.ts";
import type { SessionDraft } from "./types.ts";

function project(id: string, standalone = false) {
  return {
    id,
    name: id,
    path: `C:/work/${id}`,
    default_agent: "codex-cli" as const,
    created_at: 1,
    updated_at: 1,
    standalone,
  };
}

function session(id: string, projectId: string, updated: number): Session {
  return {
    id,
    project_id: projectId,
    agent: "codex-cli",
    native_id: id,
    title: id,
    status: "completed",
    created_at: updated,
    updated_at: updated,
  };
}

function draft(text: string): SessionDraft {
  return {
    projectId: STANDALONE_DRAFT_ID,
    agent: "claude-code",
    text,
    sandbox: null,
    tuning: null,
    collaboration: "default",
    goal: null,
    goalStatus: null,
    phase: "idle",
  };
}

function carry(text: string): DraftCarryState {
  const id = draftId(STANDALONE_DRAFT_ID);
  return {
    drafts: { [STANDALONE_DRAFT_ID]: draft(text) },
    draftFocused: { [STANDALONE_DRAFT_ID]: true },
    activeSessionId: {},
    sessions: {},
    attachments: { [id]: [{ path: "a.txt", name: "a.txt" }] },
    textSnippets: {},
    sandboxes: {},
    tuning: {},
    accessMode: {},
    events: {},
    catalogs: {},
    catalogNotices: {},
    lastSandboxByAgent: {},
    selectedProjectId: STANDALONE_DRAFT_ID,
    preferredAgent: "claude-code",
  };
}

test("composer project switch stays on the unsent standalone draft only", () => {
  assert.equal(composerShowsWorkContext(true, true), true);
  assert.equal(composerShowsWorkContext(true, false), false);
  assert.equal(composerShowsWorkContext(false, true), false);
  assert.equal(composerShowsWorkContext(false, false), false);
});

test("sidebar projects omit standalone directories", () => {
  const projects = [project("app"), project("chat", true)];
  assert.deepEqual(visibleProjects(projects).map((item) => item.id), ["app"]);
  assert.deepEqual(
    standaloneChatSessions(projects, {
      chat: [session("older", "chat", 1), session("newer", "chat", 5)],
      app: [session("hidden", "app", 9)],
    }).map((item) => item.id),
    ["newer", "older"],
  );
});

test("selection stays on an open standalone draft or chat", () => {
  const projects = [project("app"), project("chat", true)];
  assert.equal(
    keepSelectedProjectId({
      projects,
      current: null,
      standaloneDraftFocused: true,
    }),
    STANDALONE_DRAFT_ID,
  );
  assert.equal(
    keepSelectedProjectId({
      projects,
      current: "chat",
      standaloneDraftFocused: false,
    }),
    "chat",
  );
  assert.equal(
    keepSelectedProjectId({
      projects,
      current: null,
      standaloneDraftFocused: false,
    }),
    "app",
  );
  assert.equal(projectStillListed(STANDALONE_DRAFT_ID, new Set()), true);
  assert.equal(projectStillListed("gone", new Set(["app"])), false);
});

test("retarget moves the unsent draft onto a project", () => {
  const next = retargetStandaloneDraft(carry("hello"), "app");
  assert.ok(next);
  assert.equal(next?.drafts[STANDALONE_DRAFT_ID], undefined);
  assert.equal(next?.drafts.app?.text, "hello");
  assert.equal(next?.drafts.app?.projectId, "app");
  assert.equal(next?.selectedProjectId, "app");
  assert.equal(next?.draftFocused[STANDALONE_DRAFT_ID], undefined);
  assert.equal(next?.attachments[draftId("app")]?.[0]?.name, "a.txt");
  assert.equal(next?.attachments[draftId(STANDALONE_DRAFT_ID)], undefined);
});

test("a creating draft is not retargeted", () => {
  const state = carry("busy");
  state.drafts[STANDALONE_DRAFT_ID] = { ...draft("busy"), phase: "creating" };
  assert.equal(retargetStandaloneDraft(state, "app"), null);
});

test("adopted chat leaves the draft id", () => {
  const state = carry("");
  state.sessions[STANDALONE_DRAFT_ID] = [session("codex-cli:1", "real", 3)];
  state.activeSessionId[STANDALONE_DRAFT_ID] = "codex-cli:1";
  const next = adoptCreatedChat(state, STANDALONE_DRAFT_ID, session("codex-cli:1", "real", 3));
  assert.equal(next.sessions[STANDALONE_DRAFT_ID], undefined);
  assert.equal(next.sessions.real?.[0]?.id, "codex-cli:1");
  assert.equal(next.activeSessionId.real, "codex-cli:1");
  assert.equal(next.selectedProjectId, "real");
});
