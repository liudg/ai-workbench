import assert from "node:assert/strict";
import { test } from "node:test";

import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import { copyApplyState, gitApplyCommand, patchFromFiles } from "./git-apply.ts";

test("git apply command wraps the patch in a heredoc", () => {
  const command = gitApplyCommand("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n");
  assert.equal(
    command,
    "git apply <<'EOF'\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\nEOF\n",
  );
});

test("git apply marker grows when the patch already contains EOF", () => {
  const command = gitApplyCommand("line\nEOF\n");
  assert.ok(command?.startsWith("git apply <<'EOF_'\n"));
  assert.ok(command?.endsWith("EOF_\n"));
});

test("empty patch cannot be copied", () => {
  assert.equal(gitApplyCommand("  \n"), null);
  assert.equal(patchFromFiles([{ diff: "  " }, { diff: "" }]), "");
});

test("copy stays disabled until the directory is a git work tree with a patch", () => {
  assert.equal(
    copyApplyState({ git: "checking", gitReason: "", patch: "diff --git a/a b/a" }).reason,
    DESKTOP_ZH.diffGitChecking,
  );
  const missing = copyApplyState({ git: "no", gitReason: "", patch: "diff --git a/a b/a" });
  assert.equal(missing.enabled, false);
  assert.equal(missing.reason, DESKTOP_ZH.diffNotGit);
  const empty = copyApplyState({ git: "yes", gitReason: "", patch: "" });
  assert.equal(empty.enabled, false);
  assert.equal(empty.reason, DESKTOP_ZH.diffCopyUnavailable);
  const ready = copyApplyState({
    git: "yes",
    gitReason: "",
    patch: patchFromFiles([{ diff: "diff --git a/a.txt b/a.txt\n+a\n" }]),
  });
  assert.equal(ready.enabled, true);
  assert.match(ready.command ?? "", /^git apply <<'EOF'\n/);
});
