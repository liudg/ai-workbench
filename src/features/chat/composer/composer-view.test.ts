import assert from "node:assert/strict";
import { test } from "node:test";

import { emptySandbox, type AgentCapabilities, type SessionEvent } from "../../../types/index.ts";
import { deriveComposerView } from "./composer-view.ts";

const caps = {
  supports_slash: true,
  supports_resume: false,
  supports_questions: true,
  supports_tuning: true,
  supports_skills: true,
  supports_images: true,
  supports_queue: true,
  supports_plan: true,
  supports_review: true,
  changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
} satisfies AgentCapabilities;

function view(patch: Partial<Parameters<typeof deriveComposerView>[0]> = {}) {
  return deriveComposerView({
    status: "completed",
    events: [],
    caps,
    permissionMenu: null,
    sandbox: emptySandbox(),
    commands: [{ name: "/review", hint: "审查" }],
    skills: [],
    catalog: undefined,
    tuning: undefined,
    catalogNotice: null,
    text: "",
    caret: 0,
    editingId: null,
    fileCount: 0,
    goalDraft: false,
    ...patch,
  });
}

test("queue keeps the composer open while a turn is running", () => {
  const running = view({ status: "running" });
  assert.equal(running.composerLocked, false);
  assert.equal(running.menusLocked, true);
  assert.equal(running.placeholder, "添加后续消息");
  assert.equal(running.stopMode, true);
  assert.equal(running.sendDisabled, false);
  const noQueue = view({
    status: "running",
    caps: { ...caps, supports_queue: false },
  });
  assert.equal(noQueue.composerLocked, true);
  assert.equal(noQueue.placeholder, "随心输入");
  assert.equal(view({ status: "stopped" }).placeholder, "会话已停止，请新建会话");
});

test("slash stays closed while a prompt is waiting or the turn is busy", () => {
  const prompt: SessionEvent = {
    id: "p",
    session_id: "s",
    seq: 1,
    ts: 1,
    kind: "prompt",
    prompt_id: "p1",
    prompt_kind: "approval",
    question: "允许？",
    options: [],
    questions: [],
  };
  assert.equal(view({ text: "/review", events: [prompt] }).slashOpen, false);
  assert.equal(view({ text: "/review", status: "running" }).slashOpen, false);
  assert.equal(view({ text: "/review" }).slashOpen, true);
  assert.equal(view({ text: "  ", fileCount: 0 }).sendDisabled, true);
  assert.equal(view({ text: "", fileCount: 1 }).sendDisabled, false);
});

test("an empty @ opens the add menu and a query stays a file search", () => {
  const empty = view({ text: "@", caret: 1 });
  assert.equal(empty.mentionOpen, true);
  assert.equal(empty.mentionAdd, true);
  assert.equal(empty.skillOpen, false);
  const files = view({ text: "@composer", caret: "@composer".length });
  assert.equal(files.mentionAdd, false);
  assert.equal(files.mentionQuery, "composer");
  assert.equal(view({ text: "$docs", caret: 5 }).skillOpen, true);
  assert.equal(view({ text: "$docs", caret: 5 }).mentionOpen, false);
});

test("goal draft and plan mode change the placeholder only when the composer is free", () => {
  assert.equal(view({ goalDraft: true }).placeholder, "描述你的目标，定义可衡量的成功标准");
  const plan: SessionEvent = {
    id: "plan",
    session_id: "s",
    seq: 1,
    ts: 1,
    kind: "collaboration-mode",
    mode: "plan",
  };
  assert.equal(view({ events: [plan] }).placeholder, "描述你的任务以生成计划");
  assert.equal(view({ events: [plan], goalDraft: true }).placeholder, "描述你的目标，定义可衡量的成功标准");
  assert.equal(view({ status: "running", goalDraft: true }).placeholder, "添加后续消息");
  assert.equal(view({ caps: undefined }).goalSupport, "loading");
  assert.equal(view({ caps: { ...caps, supports_goals: false } }).goalSupport, "unsupported");
});
