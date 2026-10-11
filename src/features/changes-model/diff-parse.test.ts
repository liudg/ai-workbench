import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../types.ts";
import { parseUnifiedDiff, sessionChanges, turnChanges } from "./diff-parse.ts";

function event(id: string, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq: 1, ts: 1, ...body };
}

const EDIT = [
  "diff --git a/src/main.rs b/src/main.rs",
  "--- a/src/main.rs",
  "+++ b/src/main.rs",
  "@@ -1 +1,2 @@",
  "-fn main() {}",
  "+fn main() {",
  "+}",
].join("\n");

test("unified diff counts edits, additions, and deletions", () => {
  const added = [
    "diff --git a/index.html b/index.html",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/index.html",
    "@@ -0,0 +1 @@",
    "+<p>hi</p>",
  ].join("\n");
  const deleted = [
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
  ].join("\n");
  const renamed = [
    "diff --git a/old.ts b/new.ts",
    "rename from old.ts",
    "rename to new.ts",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");
  assert.deepEqual(
    parseUnifiedDiff(EDIT).map((file) => [file.path, file.status, file.added, file.removed]),
    [["src/main.rs", "M", 2, 1]],
  );
  assert.equal(parseUnifiedDiff(added)[0]?.status, "A");
  assert.equal(parseUnifiedDiff(deleted)[0]?.status, "D");
  assert.equal(parseUnifiedDiff(deleted)[0]?.path, "old.txt");
  assert.equal(parseUnifiedDiff(renamed)[0]?.status, "R");
  assert.equal(parseUnifiedDiff(renamed)[0]?.path, "new.ts");
});

test("turn changes prefer the latest summary and otherwise merge file events", () => {
  const fromFiles = turnChanges([
    event("f1", {
      kind: "file-change",
      turn_id: "turn-1",
      path: "src/main.rs",
      status: "M",
      added: 2,
      removed: 1,
      diff: EDIT,
    }),
    event("f2", {
      kind: "file-change",
      turn_id: "turn-1",
      path: "README.md",
      status: "A",
      added: 1,
      removed: 0,
      diff: "+hello",
    }),
  ]);
  assert.equal(fromFiles?.id, "turn-1");
  assert.deepEqual(
    fromFiles?.files.map((file) => [file.path, file.status, file.added]),
    [
      ["src/main.rs", "M", 2],
      ["README.md", "A", 1],
    ],
  );

  const fromSummary = turnChanges([
    event("f1", {
      kind: "file-change",
      turn_id: "turn-1",
      path: "README.md",
      status: "A",
      added: 1,
      removed: 0,
      diff: "+hello",
    }),
    event("s1", {
      kind: "turn-changes",
      turn_id: "turn-1",
      files: [
        {
          path: "src/main.rs",
          status: "M",
          added: 2,
          removed: 1,
          diff: EDIT,
        },
      ],
    }),
  ]);
  assert.equal(fromSummary?.id, "turn-1");
  assert.deepEqual(fromSummary?.files.map((file) => file.path), ["src/main.rs"]);
});

test("old diff and tool events do not create a change card", () => {
  assert.equal(
    turnChanges([
      event("d1", { kind: "turn-diff", turn_id: "turn-1", diff: EDIT }),
      event("t1", { kind: "tool-call", name: "command", summary: "src/main.rs", detail: EDIT }),
    ]),
    null,
  );
});

test("session files keep the later edit of the same path", () => {
  const files = sessionChanges([
    event("u1", { kind: "user-message", text: "一" }),
    event("d1", {
      kind: "turn-changes",
      turn_id: "t1",
      files: [{ path: "src/app.ts", status: "M", added: 1, removed: 1, diff: "-a\n+b" }],
    }),
    event("u2", { kind: "user-message", text: "二" }),
    event("d2", {
      kind: "file-change",
      turn_id: "t2",
      path: "src/app.ts",
      status: "M",
      added: 2,
      removed: 1,
      diff: "-b\n+b\n+c",
    }),
  ]);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.added, 2);
  assert.equal(files[0]?.status, "M");
});
