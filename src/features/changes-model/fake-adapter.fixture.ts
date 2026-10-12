// 测试夹具：只给 fake-adapter.test.ts 用，产品代码不得引用。
import type { ChangeCapabilities, FileChange, SessionEvent, SessionEventBody } from "../../types.ts";

/** 非 Codex 适配器的归一化变更样例。 */
export const FAKE_CAPABILITIES: ChangeCapabilities = {
  turn_diff: true,
  per_file_patch: true,
  git_scopes: false,
};

export const FAKE_TURN_ID = "fake-turn";

export const FAKE_FILE: FileChange = {
  path: "notes/fake.md",
  status: "M",
  added: 2,
  removed: 1,
  diff: ["@@ -1 +1,2 @@", "-old", "+new", "+line"].join("\n"),
};

function fakeAdapterBodies(): SessionEventBody[] {
  return [
    { kind: "user-message", text: "改一下说明" },
    {
      kind: "agent-message",
      text: "已经改好。",
      phase: "final-answer",
    },
    {
      kind: "file-change",
      turn_id: FAKE_TURN_ID,
      path: FAKE_FILE.path,
      status: FAKE_FILE.status,
      added: FAKE_FILE.added,
      removed: FAKE_FILE.removed,
      diff: FAKE_FILE.diff,
    },
    { kind: "turn-changes", turn_id: FAKE_TURN_ID, files: [FAKE_FILE] },
    { kind: "turn-diff", turn_id: FAKE_TURN_ID, diff: "diff --git a/ignored b/ignored\n" },
    { kind: "tool-call", name: "command", summary: "noop", detail: "" },
  ];
}

export function fakeAdapterEvents(): SessionEvent[] {
  return fakeAdapterBodies().map((body, index) => ({
    id: `fake-${index + 1}`,
    session_id: "fake-session",
    seq: index + 1,
    ts: 1_000 + index,
    ...body,
  }));
}
