import assert from "node:assert/strict";
import { test } from "node:test";

import { draftId, isDraftId } from "../../store/draft-session.ts";
import type { SessionDraft } from "../../store/types.ts";
import type { Session } from "../../types/index.ts";
import { visibleWorkspaceSession } from "./workspace-session.ts";

function draft(): SessionDraft {
  return {
    projectId: "p1",
    agent: "codex-cli",
    text: "",
    sandbox: null,
    tuning: null,
    collaboration: "default",
    goal: null,
    goalStatus: null,
    phase: "idle",
  };
}

function session(): Session {
  return {
    id: "codex-cli:live",
    project_id: "p1",
    agent: "codex-cli",
    native_id: "live",
    title: "进行中",
    status: "completed",
    created_at: 1,
    updated_at: 2,
    archived: false,
  };
}

test("a project with no sessions shows the lazy draft", () => {
  const visible = visibleWorkspaceSession({
    sessions: [],
    activeSessionId: undefined,
    draft: draft(),
    draftFocused: false,
  });
  assert.equal(visible?.id, draftId("p1"));
  assert.equal(visible ? isDraftId(visible.id) : false, true);
});

test("an empty project without a draft has nothing to show yet", () => {
  assert.equal(
    visibleWorkspaceSession({
      sessions: [],
      activeSessionId: undefined,
      draft: undefined,
      draftFocused: false,
    }),
    null,
  );
});

test("a project that still has sessions keeps the selected one", () => {
  const live = session();
  const visible = visibleWorkspaceSession({
    sessions: [live],
    activeSessionId: live.id,
    draft: draft(),
    draftFocused: false,
  });
  assert.equal(visible?.id, live.id);
});

test("sessions that are still loading do not pretend the project is empty", () => {
  assert.equal(
    visibleWorkspaceSession({
      sessions: undefined,
      activeSessionId: undefined,
      draft: draft(),
      draftFocused: false,
    }),
    null,
  );
});

test("an open draft stays in front of a live session", () => {
  const visible = visibleWorkspaceSession({
    sessions: [session()],
    activeSessionId: session().id,
    draft: draft(),
    draftFocused: true,
  });
  assert.equal(visible?.id, draftId("p1"));
});
