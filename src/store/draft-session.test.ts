import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentCatalog, Session, SessionSandbox, SessionTuning } from "../types/index.ts";
import type { SessionDraft } from "./types.ts";
import {
  applyDraftSend,
  claimDraft,
  draftId,
  finishDraft,
  firstSendBody,
  isPendingId,
  openProjectDraft,
  pendingSidebarSession,
  releaseDraft,
  reserveDraftSend,
  releaseDraftSend,
  runDraftSend,
  type DraftCarryState,
} from "./draft-session.ts";

function sandbox(mode: SessionSandbox["mode"] = "full"): SessionSandbox {
  return { mode, networkAccess: false, writableRoots: [], profileId: "" };
}

function draft(patch: Partial<SessionDraft> = {}): SessionDraft {
  return {
    projectId: "p1",
    agent: "claude-code",
    text: "hello",
    sandbox: sandbox(),
    tuning: null,
    collaboration: "default",
    goal: null,
    goalStatus: null,
    phase: "idle",
    ...patch,
  };
}

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "claude-code:native-1",
    project_id: "p1",
    agent: "claude-code",
    native_id: "native-1",
    title: "未命名会话",
    status: "running",
    created_at: 10,
    updated_at: 20,
    archived: false,
    ...patch,
  };
}

function carry(current: SessionDraft, extras: Partial<DraftCarryState> = {}): DraftCarryState {
  const id = draftId(current.projectId);
  return {
    drafts: { [current.projectId]: current },
    draftFocused: { [current.projectId]: true },
    activeSessionId: {},
    sessions: { [current.projectId]: [] },
    attachments: { [id]: [{ path: "/tmp/a.png", name: "a.png" }] },
    textSnippets: {},
    sandboxes: current.sandbox ? { [id]: current.sandbox } : {},
    tuning: current.tuning ? { [id]: current.tuning } : {},
    accessMode: {},
    events: {},
    catalogs: {},
    catalogNotices: {},
    lastSandboxByAgent: {},
    selectedProjectId: current.projectId,
    preferredAgent: current.agent,
    ...extras,
  };
}

const tuning: SessionTuning = { model: "opus", effort: "high", serviceTier: null };

test("switching agent on a draft drops the other agent's model, plan, and goal", () => {
  const existing = draft({
    agent: "claude-code",
    text: "keep me",
    tuning,
    collaboration: "plan",
    goal: "ship",
    goalStatus: "paused",
  });
  const next = openProjectDraft(existing, "p1", "codex-cli", sandbox("ask"));
  assert.equal(next.text, "keep me");
  assert.equal(next.agent, "codex-cli");
  assert.equal(next.tuning, null);
  assert.equal(next.collaboration, "default");
  assert.equal(next.goal, null);
  assert.equal(next.sandbox?.mode, "ask");
  assert.equal(openProjectDraft(existing, "p1", "claude-code", sandbox("read-only")), existing);
});

test("first send body carries claude and codex defaults only when the draft set them", () => {
  const claude = firstSendBody(draft(), { text: "hi" });
  assert.equal(claude.agent, "claude-code");
  assert.equal(claude.accessMode, "full");
  assert.equal(claude.applyAccess, false);
  assert.equal(claude.applyTuning, false);
  assert.equal(claude.applyServiceTier, false);
  assert.equal(claude.collaborationMode, null);
  assert.equal(claude.text, "hi");
  assert.equal(claude.worktree, false);

  const codex = firstSendBody(
    draft({
      agent: "codex-cli",
      sandbox: { mode: "ask", networkAccess: true, writableRoots: ["/tmp/w"], profileId: "prof" },
      tuning,
      collaboration: "plan",
      goal: "  ship  ",
      goalStatus: "paused",
    }),
    { text: "go", images: ["a.png"] },
  );
  assert.equal(codex.accessMode, "ask");
  assert.equal(codex.applyAccess, true);
  assert.equal(codex.networkAccess, true);
  assert.deepEqual(codex.writableRoots, ["/tmp/w"]);
  assert.equal(codex.profileId, "prof");
  assert.equal(codex.applyTuning, true);
  assert.equal(codex.model, "opus");
  assert.equal(codex.effort, "high");
  assert.equal(codex.applyServiceTier, true);
  assert.equal(codex.serviceTier, null);
  assert.equal(codex.collaborationMode, "plan");
  assert.equal(codex.goal, "ship");
  assert.equal(codex.goalStatus, "paused");
  assert.deepEqual(codex.images, ["a.png"]);
  assert.equal(codex.worktree, false);
  assert.equal(firstSendBody(draft({ worktree: true }), { text: "hi" }).worktree, true);
  assert.equal(
    firstSendBody(draft({ projectId: "standalone", worktree: true }), { text: "hi" }).worktree,
    false,
  );
});

test("draft first send success removes the draft and selects the real session", async () => {
  const projectId = "success-project";
  const current = claimDraft(draft({ projectId, tuning, text: "first" }));
  assert.ok(current);
  assert.equal(current.phase, "creating");
  const created = session({ project_id: projectId, updated_at: 50 });
  const result = await runDraftSend(projectId, async () => ({ session: created }));
  assert.equal(result.ok, true);
  const state = carry(current, {
    catalogs: {
      [draftId(projectId)]: { agent: "claude-code" } as AgentCatalog,
    },
  });
  const settled = applyDraftSend(state, projectId, result, [
    session({ id: "older", updated_at: 1 }),
  ], { dismissed: false, sentText: "first" });
  assert.equal(settled.sent, true);
  assert.ok(settled.patch);
  assert.equal(settled.patch.drafts[projectId], undefined);
  assert.equal(settled.patch.draftFocused[projectId], false);
  assert.equal(settled.patch.activeSessionId[projectId], created.id);
  assert.equal(settled.patch.sessions[projectId]?.[0]?.id, created.id);
  assert.equal(settled.patch.attachments[draftId(projectId)], undefined);
  assert.equal(settled.patch.sandboxes[created.id]?.mode, "full");
  assert.equal(settled.patch.tuning[created.id]?.model, "opus");
  assert.equal(settled.patch.catalogs[created.id]?.agent, "claude-code");
  assert.equal(settled.patch.catalogs[draftId(projectId)], undefined);
  assert.equal(settled.patch.lastError, null);
});

test("draft first send failure keeps the draft text and unlocks it", async () => {
  const projectId = "failure-project";
  const current = claimDraft(
    draft({
      projectId,
      agent: "codex-cli",
      text: "do not lose this",
      tuning,
      sandbox: sandbox("ask"),
    }),
  );
  assert.ok(current);
  const result = await runDraftSend(projectId, async () => {
    throw new Error("cli down");
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skipped, false);
  assert.match(result.error, /cli down/);
  const settled = applyDraftSend(carry(current), projectId, result, [], {
    dismissed: false,
    sentText: "do not lose this",
  });
  assert.equal(settled.sent, false);
  assert.ok(settled.patch);
  const kept = settled.patch.drafts[projectId];
  assert.ok(kept);
  assert.equal(kept.phase, "idle");
  assert.equal(kept.text, "do not lose this");
  assert.equal(kept.agent, "codex-cli");
  assert.equal(kept.tuning?.model, "opus");
  assert.equal(kept.sandbox?.mode, "ask");
  assert.equal(settled.patch.lastError, result.error);
  assert.deepEqual(settled.patch.sessions[projectId], []);
  assert.equal(settled.patch.activeSessionId[projectId], undefined);
  assert.equal(releaseDraft(kept), kept);
});

test("a second first send while one is in flight does not touch the draft", async () => {
  const projectId = "inflight-project";
  assert.equal(reserveDraftSend(projectId), true);
  const skipped = await runDraftSend(projectId, async () => ({ session: session() }));
  assert.deepEqual(skipped, { ok: false, error: "", skipped: true });
  const creating = draft({ projectId, phase: "creating", text: "still here" });
  const settled = applyDraftSend(carry(creating), projectId, skipped, [], {
    dismissed: false,
    sentText: "still here",
  });
  assert.equal(settled.patch, null);
  assert.equal(settled.sent, false);
  releaseDraftSend(projectId);
});

test("finish draft does not copy a catalog from a different agent", () => {
  const projectId = "catalog-project";
  const current = draft({ projectId, agent: "codex-cli" });
  const created = session({
    id: "codex-cli:n",
    project_id: projectId,
    agent: "codex-cli",
    native_id: "n",
  });
  const next = finishDraft(
    carry(current, {
      catalogs: { [draftId(projectId)]: { agent: "claude-code" } as AgentCatalog },
    }),
    projectId,
    created,
    [],
  );
  assert.equal(next.catalogs[created.id], undefined);
  assert.equal(next.drafts[projectId], undefined);
});

test("an idle draft has no sidebar row, and a creating draft is only a pending placeholder", () => {
  const idle = draft({ projectId: "idle-project", text: "not yet" });
  assert.equal(pendingSidebarSession("idle-project", idle, undefined), null);
  const creating = draft({
    projectId: "idle-project",
    phase: "creating",
    text: "  first line\nrest",
    creatingSince: 40,
  });
  const row = pendingSidebarSession("idle-project", creating, undefined);
  assert.ok(row);
  assert.equal(isPendingId(row.id), true);
  assert.equal(row.native_id, "");
  assert.notEqual(row.id, draftId("idle-project"));
  assert.equal(row.title, "first line");
  assert.equal(row.status, "running");
  assert.equal(claimDraft(creating), null);
});

test("a created session whose first message failed stays selected and restores the text", () => {
  const projectId = "partial-project";
  const current = draft({
    projectId,
    phase: "creating",
    text: "keep the prompt",
    tuning,
  });
  const created = session({ id: "codex-cli:real", project_id: projectId, agent: "codex-cli", native_id: "real" });
  const settled = applyDraftSend(
    carry(current),
    projectId,
    {
      ok: true,
      value: { session: created, messageError: "会话已创建，第一条消息没有发出。连接中断" },
    },
    [],
    { dismissed: false, sentText: "keep the prompt" },
  );
  assert.equal(settled.sent, false);
  assert.ok(settled.patch);
  assert.equal(settled.patch.drafts[projectId], undefined);
  assert.equal(settled.patch.activeSessionId[projectId], created.id);
  assert.equal(settled.patch.sessions[projectId]?.[0]?.id, created.id);
  assert.equal(settled.patch.lastError, "会话已创建，第一条消息没有发出。连接中断");
  assert.equal(settled.patch.attachments[created.id]?.[0]?.name, "a.png");
  assert.equal(settled.patch.attachments[draftId(projectId)], undefined);
  assert.deepEqual(settled.restore, { sessionId: created.id, text: "keep the prompt" });
});

test("cancelling before the first message lands unlocks the draft and does not select a session", () => {
  const projectId = "cancel-project";
  const current = draft({
    projectId,
    phase: "creating",
    text: "still drafting",
    cancelRequested: true,
  });
  const created = session({ project_id: projectId });
  const settled = applyDraftSend(
    carry(current),
    projectId,
    { ok: true, value: { session: created, messageError: "会话已创建，第一条消息没有发出" } },
    [],
    { dismissed: true, sentText: "still drafting" },
  );
  assert.equal(settled.sent, false);
  assert.equal(settled.restore, null);
  assert.ok(settled.patch);
  assert.equal(settled.patch.drafts[projectId]?.phase, "idle");
  assert.equal(settled.patch.drafts[projectId]?.text, "still drafting");
  assert.equal(settled.patch.drafts[projectId]?.cancelRequested, false);
  assert.equal(settled.patch.lastError, null);
  assert.equal(settled.patch.activeSessionId[projectId], undefined);
  assert.deepEqual(settled.patch.sessions[projectId], []);
});

test("whitespace does not block an image-only first send", () => {
  const body = firstSendBody(draft({ text: "  \n" }), { text: "  \n", images: ["shot.png"] });
  assert.deepEqual(body.images, ["shot.png"]);
  assert.equal(body.text, "  \n");
  assert.equal(body.standalone, false);
});

test("a standalone draft asks the backend to create the task folder on first send", () => {
  const body = firstSendBody(draft({ projectId: "standalone" }), { text: "整理发布说明" });
  assert.equal(body.standalone, true);
  assert.equal(body.projectId, "standalone");
});
