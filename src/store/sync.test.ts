import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearMissingSessionBanner,
  deselectSession,
  isMissingSessionError,
  visibleBanner,
  withoutSession,
} from "./missing-session.ts";

test("a live timeline clears a missing-session banner even when the session is writable", () => {
  const cleared = clearMissingSessionBanner("会话不存在或已结束", [
    { kind: "user-message" },
    { kind: "agent-message" },
  ]);
  assert.equal(cleared, null);
  assert.equal(clearMissingSessionBanner("会话不存在", [{ kind: "plan-text" }]), null);
});

test("the missing-session text is never a visible banner", () => {
  assert.equal(visibleBanner("会话不存在或已结束"), null);
  assert.equal(visibleBanner("会话不存在"), null);
  assert.equal(visibleBanner("无法归档对话"), "无法归档对话");
  assert.equal(visibleBanner(null), null);
});

test("a session that is truly gone is deselected and dropped from the lists", () => {
  assert.equal(isMissingSessionError(new Error("会话不存在或已结束")), true);
  assert.equal(isMissingSessionError("等待 Codex model/list 超时"), false);
  const active = deselectSession(
    { project: "codex-cli:gone", other: "codex-cli:keep" },
    "codex-cli:gone",
  );
  assert.deepEqual(active, { other: "codex-cli:keep" });
  const sessions = withoutSession(
    { project: [{ id: "codex-cli:gone" } as never, { id: "codex-cli:keep" } as never] },
    "codex-cli:gone",
  );
  assert.deepEqual(
    sessions.project.map((session) => session.id),
    ["codex-cli:keep"],
  );
});
