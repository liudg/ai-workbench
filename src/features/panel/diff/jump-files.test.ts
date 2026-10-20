import assert from "node:assert/strict";
import { test } from "node:test";

import { filterJumpFiles, jumpFileParts, jumpSelection, visibleJumpFiles } from "./jump-files.ts";

const files = [
  { path: "Library/GemFeedback/inspect_prefab.cs" },
  { path: "Library/GemFeedback/invoke.ps1" },
  { path: "Scripts/GameUI/PlayerEquipment.cs" },
];

test("jump row splits the file name from its parent path", () => {
  assert.deepEqual(jumpFileParts("Library/GemFeedback/inspect_prefab.cs"), {
    name: "inspect_prefab.cs",
    dir: "Library/GemFeedback",
  });
  assert.deepEqual(jumpFileParts("note.txt"), { name: "note.txt", dir: "" });
});

test("jump list is the files currently shown for the scope", () => {
  const shown = [{ path: "qa-dirty-note.md" }];
  assert.deepEqual(
    visibleJumpFiles(shown).map((file) => file.path),
    ["qa-dirty-note.md"],
  );
  assert.deepEqual(visibleJumpFiles([]), []);
  assert.equal(jumpSelection(shown, "qa-dirty-note.md"), "qa-dirty-note.md");
  assert.equal(jumpSelection(shown, "session-only.md"), null);
  assert.equal(jumpSelection([], "qa-dirty-note.md"), null);
});

test("jump filter matches the file name or the directory", () => {
  assert.deepEqual(
    filterJumpFiles(files, "invoke").map((file) => file.path),
    ["Library/GemFeedback/invoke.ps1"],
  );
  assert.deepEqual(
    filterJumpFiles(files, "gameui").map((file) => file.path),
    ["Scripts/GameUI/PlayerEquipment.cs"],
  );
  assert.equal(filterJumpFiles(files, "   ").length, files.length);
});
