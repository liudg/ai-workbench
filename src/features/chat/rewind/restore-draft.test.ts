import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent } from "../../../types/index.ts";
import { canRewindUserEvent, parseRewoundDraft } from "./restore-draft.ts";

test("parseRewoundDraft extracts inline attachments from composer-submit format and merges restoredImages", () => {
  const restored = parseRewoundDraft(
    "请检查以下两份文件\n\n附件：C:\\docs\\spec.pdf、/Users/dev/notes.md",
    ["C:\\shots\\screen.png", "C:\\docs\\spec.pdf"],
  );
  assert.equal(restored.text, "请检查以下两份文件");
  assert.deepEqual(restored.files, [
    { path: "C:\\shots\\screen.png", name: "screen.png" },
    { path: "C:\\docs\\spec.pdf", name: "spec.pdf" },
    { path: "/Users/dev/notes.md", name: "notes.md" },
  ]);
});

test("parseRewoundDraft preserves body newlines when stripping inline attachment suffix", () => {
  const restored = parseRewoundDraft(
    "第一行\n第二行\n\n附件：g:/repo/README.md、g:/repo/package.json",
    [],
  );
  assert.equal(restored.text, "第一行\n第二行");
  assert.deepEqual(restored.files, [
    { path: "g:/repo/README.md", name: "README.md" },
    { path: "g:/repo/package.json", name: "package.json" },
  ]);
});

test("parseRewoundDraft leaves plain text untouched when there are no trailing attachments", () => {
  const restored = parseRewoundDraft("仅文字消息", []);
  assert.equal(restored.text, "仅文字消息");
  assert.deepEqual(restored.files, []);
});

test("parseRewoundDraft preserves Chinese enumeration commas inside file paths while still splitting bare names", () => {
  const withPaths = parseRewoundDraft(
    "审阅文档\n\n附件：C:\\docs\\一、总览.md、/Users/a/二、设计.png、\\\\nas\\share\\三、附录.pdf、./四、说明.txt",
    [],
  );
  assert.equal(withPaths.text, "审阅文档");
  assert.deepEqual(withPaths.files, [
    { path: "C:\\docs\\一、总览.md", name: "一、总览.md" },
    { path: "/Users/a/二、设计.png", name: "二、设计.png" },
    { path: "\\\\nas\\share\\三、附录.pdf", name: "三、附录.pdf" },
    { path: "./四、说明.txt", name: "四、说明.txt" },
  ]);

  const bareNames = parseRewoundDraft("仅文件名\n\n附件：spec.pdf、notes.md", []);
  assert.equal(bareNames.text, "仅文件名");
  assert.deepEqual(bareNames.files, [
    { path: "spec.pdf", name: "spec.pdf" },
    { path: "notes.md", name: "notes.md" },
  ]);
});

test("canRewindUserEvent gates strictly on host.requestRewind, supports_conversation_rewind, and real user message", () => {
  const userMsg: SessionEvent = {
    id: "u1",
    session_id: "s1",
    seq: 1,
    ts: 1,
    kind: "user-message",
    text: "帮我重构登录流程",
  };
  assert.equal(
    canRewindUserEvent({
      hasHostRewind: true,
      event: userMsg,
      supportsConversationRewind: true,
    }),
    true,
  );
  assert.equal(
    canRewindUserEvent({
      hasHostRewind: false,
      event: userMsg,
      supportsConversationRewind: true,
    }),
    false,
  );
  assert.equal(
    canRewindUserEvent({
      hasHostRewind: true,
      event: userMsg,
      supportsConversationRewind: false,
    }),
    false,
  );
  assert.equal(
    canRewindUserEvent({
      hasHostRewind: true,
      event: userMsg,
      supportsConversationRewind: undefined,
    }),
    false,
  );
  assert.equal(
    canRewindUserEvent({
      hasHostRewind: true,
      event: { ...userMsg, text: "  /goal  " },
      supportsConversationRewind: true,
    }),
    false,
  );
  assert.equal(
    canRewindUserEvent({
      hasHostRewind: true,
      event: { ...userMsg, sender: { task_ids: ["t2"] } },
      supportsConversationRewind: true,
    }),
    false,
  );
});
