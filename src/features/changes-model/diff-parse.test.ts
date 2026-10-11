import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../types.ts";
import { isPatchTool, parsePatchDetail, parseUnifiedDiff, sessionChanges, turnChanges } from "./diff-parse.ts";

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

test("patch events merge by path and turns prefer the latest turn diff", () => {
  const detail = [
    "update src/main.rs",
    EDIT,
    "",
    "add README.md",
    "--- /dev/null",
    "+++ b/README.md",
    "@@ -0,0 +1 @@",
    "+hello",
  ].join("\n");
  const parsed = parsePatchDetail(detail);
  assert.deepEqual(
    parsed.map((file) => [file.path, file.status, file.added]),
    [
      ["src/main.rs", "M", 2],
      ["README.md", "A", 1],
    ],
  );
  assert.equal(isPatchTool("apply_patch"), true);
  assert.equal(isPatchTool("fileChange"), true);
  assert.equal(isPatchTool("command"), false);

  const fromPatch = turnChanges([
    event("t1", {
      kind: "tool-call",
      name: "apply_patch",
      summary: "src/main.rs",
      detail,
    }),
  ]);
  assert.equal(fromPatch?.files.length, 2);

  const fromDiff = turnChanges([
    event("t1", {
      kind: "tool-call",
      name: "apply_patch",
      summary: "README.md",
      detail: "add README.md\n+hello",
    }),
    event("d1", { kind: "turn-diff", turn_id: "turn-1", diff: EDIT }),
  ]);
  assert.equal(fromDiff?.id, "turn-1");
  assert.deepEqual(fromDiff?.files.map((file) => file.path), ["src/main.rs"]);
});

test("session files keep the later edit of the same path", () => {
  const first = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");
  const second = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1,2 @@",
    "-b",
    "+b",
    "+c",
  ].join("\n");
  const files = sessionChanges([
    event("u1", { kind: "user-message", text: "一" }),
    event("d1", { kind: "turn-diff", turn_id: "t1", diff: first }),
    event("u2", { kind: "user-message", text: "二" }),
    event("d2", { kind: "turn-diff", turn_id: "t2", diff: second }),
  ]);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.added, 2);
  assert.equal(files[0]?.status, "M");
});
