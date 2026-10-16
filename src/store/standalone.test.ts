import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "@/types";
import { draftId, type DraftCarryState } from "./draft-session.ts";
import {
  adoptCreatedChat,
  composerShowsWorkContext,
  hasUserMessage,
  keepSelectedProjectId,
  projectStillListed,
  releaseUntouchedNewChat,
  retargetEmptyDraft,
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

test("project switch stays on every empty session and hides after the first user message", () => {
  assert.equal(hasUserMessage([{ kind: "status-changed" }, { kind: "user-message" }]), true);
  assert.equal(hasUserMessage([{ kind: "collaboration-mode" }]), false);
  assert.equal(
    composerShowsWorkContext({ draft: true, eventsLoaded: false, hasUserMessage: false }),
    true,
  );
  assert.equal(
    composerShowsWorkContext({ draft: false, eventsLoaded: true, hasUserMessage: false }),
    true,
  );
  assert.equal(
    composerShowsWorkContext({ draft: false, eventsLoaded: false, hasUserMessage: false }),
    false,
  );
  assert.equal(
    composerShowsWorkContext({ draft: true, eventsLoaded: true, hasUserMessage: true }),
    false,
  );
  assert.equal(
    composerShowsWorkContext({ draft: false, eventsLoaded: true, hasUserMessage: true }),
    false,
  );
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
    STANDALONE_DRAFT_ID,
  );
  assert.equal(
    keepSelectedProjectId({
      projects,
      current: null,
      standaloneDraftFocused: false,
      focusedProjectId: "app",
    }),
    "app",
  );
  assert.equal(
    keepSelectedProjectId({
      projects,
      current: "app",
      standaloneDraftFocused: true,
    }),
    "app",
  );
  assert.equal(projectStillListed(STANDALONE_DRAFT_ID, new Set()), true);
  assert.equal(projectStillListed("gone", new Set(["app"])), false);
});

test("no user project stays on choose-a-project instead of a new chat", () => {
  assert.equal(
    keepSelectedProjectId({
      projects: [],
      current: null,
      standaloneDraftFocused: false,
    }),
    null,
  );
  assert.equal(
    keepSelectedProjectId({
      projects: [project("chat", true)],
      current: null,
      standaloneDraftFocused: false,
    }),
    null,
  );
  assert.equal(
    keepSelectedProjectId({
      projects: [],
      current: STANDALONE_DRAFT_ID,
      standaloneDraftFocused: false,
    }),
    null,
  );
  assert.equal(
    keepSelectedProjectId({
      projects: [],
      current: null,
      standaloneDraftFocused: true,
    }),
    STANDALONE_DRAFT_ID,
  );
  assert.deepEqual(
    releaseUntouchedNewChat({
      hasUserProject: false,
      selectedProjectId: STANDALONE_DRAFT_ID,
      draftText: "",
      draftFocused: { [STANDALONE_DRAFT_ID]: true },
    }),
    { selectedProjectId: null, draftFocused: {} },
  );
  assert.equal(
    releaseUntouchedNewChat({
      hasUserProject: false,
      selectedProjectId: STANDALONE_DRAFT_ID,
      draftText: "留下的字",
      draftFocused: { [STANDALONE_DRAFT_ID]: true },
    }),
    null,
  );
  assert.equal(
    releaseUntouchedNewChat({
      hasUserProject: true,
      selectedProjectId: STANDALONE_DRAFT_ID,
      draftText: "",
      draftFocused: { [STANDALONE_DRAFT_ID]: true },
    }),
    null,
  );
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

test("an empty project draft can move to another project or back to chat", () => {
  const state = carry("hello");
  state.drafts.app = { ...draft("from-project"), projectId: "app" };
  state.draftFocused = { app: true };
  state.selectedProjectId = "app";
  const toOther = retargetEmptyDraft(state, "app", "notes");
  assert.equal(toOther?.drafts.app, undefined);
  assert.equal(toOther?.drafts.notes?.projectId, "notes");
  assert.equal(toOther?.selectedProjectId, "notes");
  const toChat = retargetEmptyDraft(state, "app", STANDALONE_DRAFT_ID);
  assert.equal(toChat?.drafts.app, undefined);
  assert.equal(toChat?.drafts[STANDALONE_DRAFT_ID]?.text, "from-project");
  assert.equal(toChat?.selectedProjectId, STANDALONE_DRAFT_ID);
  assert.equal(toChat?.draftFocused[STANDALONE_DRAFT_ID], true);
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
