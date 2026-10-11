import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../../types.ts";
import { CODEX_DESKTOP } from "../codex-desktop.ts";
import {
  changeActions,
  FILE_LIST_LIMIT,
  isPatchTool,
  parsePatchDetail,
  diffScopeMenu,
  foldDiffLines,
  parseUnifiedDiff,
  previewKindForPath,
  resolvePreviewPath,
  sessionChanges,
  turnChanges,
  visibleChangeFiles,
} from "./model.ts";

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

test("change card actions are view and show-more, never undo", () => {
  assert.deepEqual(changeActions(1, true, false), [CODEX_DESKTOP.viewChanges]);
  assert.deepEqual(changeActions(FILE_LIST_LIMIT + 1, true, false), [
    CODEX_DESKTOP.viewChanges,
    CODEX_DESKTOP.showMore,
  ]);
  assert.equal(changeActions(8, true, true).includes(CODEX_DESKTOP.showMore), false);
  const labels = changeActions(8, true, false);
  assert.equal(labels.includes("撤销"), false);
  assert.equal(visibleChangeFiles([1, 2, 3, 4], true, false).length, FILE_LIST_LIMIT);
  assert.deepEqual(visibleChangeFiles([1, 2, 3, 4], true, true), [1, 2, 3, 4]);
  assert.deepEqual(visibleChangeFiles([1, 2], false, false), []);
});

test("diff scope menu matches the Codex previous-turn list", () => {
  assert.deepEqual(
    diffScopeMenu().map((item) => [item.label, item.submenu]),
    [
      ["上一轮", false],
      ["未提交", false],
      ["未暂存", false],
      ["已暂存", false],
      ["已提交", true],
      ["分支", true],
    ],
  );
});

test("unchanged lines between hunks collapse into unmodified bars", () => {
  const diff = [
    "diff --git a/annotate.html b/annotate.html",
    "--- a/annotate.html",
    "+++ b/annotate.html",
    "@@ -11,3 +11,4 @@",
    " p.note { color: #555; }",
    "+#p1 { font-size: 18px; }",
    " </",
    "@@ -22,1 +23,2 @@",
    "-</html>",
    "\\ No newline at end of file",
    "+</html>",
  ].join("\n");
  const rows = foldDiffLines(diff);
  assert.deepEqual(
    rows.map((row) =>
      row.kind === "collapse" ? `hide ${row.count}` : `${row.tone}:${row.lineNo}:${row.text}`,
    ),
    [
      "hide 10",
      "context:11:p.note { color: #555; }",
      "add:12:#p1 { font-size: 18px; }",
      "context:13:</",
      "hide 8",
      "del:22:</html>",
      "meta:null:No newline at end of file",
      "add:23:</html>",
    ],
  );
});

test("preview links stay inside the project", () => {
  const root = "C:/work/demo";
  assert.equal(resolvePreviewPath(root, "index.html"), "C:/work/demo/index.html");
  assert.equal(resolvePreviewPath(root, "docs/notes.md"), "C:/work/demo/docs/notes.md");
  assert.equal(resolvePreviewPath(root, "file:///C:/work/demo/readme.txt"), "C:/work/demo/readme.txt");
  assert.equal(resolvePreviewPath(root, "../secret.txt"), null);
  assert.equal(resolvePreviewPath(root, "C:/work/demo-evil/index.html"), null);
  assert.equal(resolvePreviewPath(root, "https://example.com/a.html"), null);
  assert.equal(previewKindForPath("C:/work/demo/index.html"), "html");
  assert.equal(previewKindForPath("notes.md"), "markdown");
  assert.equal(previewKindForPath("src/app.ts"), "text");
});
