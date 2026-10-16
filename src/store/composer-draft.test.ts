import assert from "node:assert/strict";
import { test } from "node:test";

import {
  composerDraftsAfterSend,
  composerTextOnMount,
  rememberSessionComposerDraft,
} from "./composer-draft.ts";
import { draftId, pendingId } from "./draft-session.ts";

test("switching sessions restores each unsent composer draft", () => {
  let drafts: Record<string, string> = {};
  drafts = rememberSessionComposerDraft(drafts, "session-a", "甲还没发");
  drafts = rememberSessionComposerDraft(drafts, "session-b", "乙还没发");
  drafts = rememberSessionComposerDraft(drafts, "session-a", "甲改过");

  assert.equal(read("session-a", drafts), "甲改过");
  assert.equal(read("session-b", drafts), "乙还没发");
  assert.equal(read("session-c", drafts), "");
});

test("empty text drops that session draft and leaves the other", () => {
  const drafts = rememberSessionComposerDraft(
    rememberSessionComposerDraft({ "session-b": "乙" }, "session-a", "甲"),
    "session-a",
    "",
  );
  assert.equal(drafts["session-a"], undefined);
  assert.equal(drafts["session-b"], "乙");
  assert.equal(rememberSessionComposerDraft(drafts, "session-b", "乙"), drafts);
  assert.equal(rememberSessionComposerDraft(drafts, "session-a", ""), drafts);
});

test("a successful send clears only the text that was sent", () => {
  const drafts = { "session-a": "发出去", "session-b": "还留着" };
  const cleared = composerDraftsAfterSend(drafts, "session-a", "发出去", "发出去", true);
  assert.equal(cleared["session-a"], undefined);
  assert.equal(cleared["session-b"], "还留着");

  const replaced = composerDraftsAfterSend(
    { "session-a": "后打的" },
    "session-a",
    "发出去",
    "发出去",
    true,
  );
  assert.equal(replaced["session-a"], "后打的");

  const trimmed = composerDraftsAfterSend(
    { "session-a": "  发出去  " },
    "session-a",
    "  发出去  ",
    "发出去",
    true,
  );
  assert.equal(trimmed["session-a"], undefined);
});

test("a failed send keeps the unsent draft", () => {
  const drafts = { "session-a": "没发出去" };
  const kept = composerDraftsAfterSend(drafts, "session-a", "没发出去", "没发出去", false);
  assert.equal(kept, drafts);
  assert.equal(kept["session-a"], "没发出去");
});

test("lazy project drafts stay on the project path", () => {
  const lazy = draftId("project-1");
  const pending = pendingId("project-1");
  const drafts = { "session-a": "真实会话" };
  assert.equal(rememberSessionComposerDraft(drafts, lazy, "懒草稿"), drafts);
  assert.equal(rememberSessionComposerDraft(drafts, pending, "占位"), drafts);
  assert.equal(
    composerDraftsAfterSend({ ...drafts, [lazy]: "不该清" }, lazy, "不该清", "不该清", true)[lazy],
    "不该清",
  );
  assert.equal(
    composerTextOnMount({
      sessionId: lazy,
      projectDraftText: "项目里的",
      parkedText: "一次性",
      sessionDrafts: { [lazy]: "会话缓存" },
    }),
    "项目里的",
  );
  assert.equal(
    composerTextOnMount({
      sessionId: lazy,
      projectDraftText: undefined,
      parkedText: null,
      sessionDrafts: {},
    }),
    "",
  );
});

test("a parked failure refill wins over the session cache once", () => {
  assert.equal(
    composerTextOnMount({
      sessionId: "session-a",
      projectDraftText: "项目草稿",
      parkedText: "第一条没发出",
      sessionDrafts: { "session-a": "旧的未发送" },
    }),
    "第一条没发出",
  );
  assert.equal(
    composerTextOnMount({
      sessionId: "session-a",
      projectDraftText: "项目草稿",
      parkedText: null,
      sessionDrafts: { "session-a": "旧的未发送" },
    }),
    "旧的未发送",
  );
});

function read(sessionId: string, drafts: Record<string, string>): string {
  return composerTextOnMount({
    sessionId,
    projectDraftText: "项目草稿",
    parkedText: null,
    sessionDrafts: drafts,
  });
}
