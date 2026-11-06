import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalOpenPath,
  clearOpenFilesOnScope,
  closeOpenFile,
  keepOpenFile,
  openFileInPlace,
  openFilesPlace,
  selectOpenFile,
} from "./open-files-place.ts";

test("open files place reads a saved path and ignores a blank line", () => {
  assert.deepEqual(openFilesPlace({ title: "打开文件", path: "src/a.ts", line: 4 }), {
    path: "src/a.ts",
    line: 4,
    filter: "",
    tabs: [{ path: "src/a.ts", line: 4 }],
  });
  assert.deepEqual(openFilesPlace({ title: "打开文件" }), { path: "", line: null, filter: "", tabs: [] });
  assert.deepEqual(openFilesPlace({ path: "a.ts", line: 0 }), {
    path: "a.ts",
    line: null,
    filter: "",
    tabs: [{ path: "a.ts", line: null }],
  });
  assert.deepEqual(openFilesPlace(null), { path: "", line: null, filter: "", tabs: [] });
});

test("open files place keeps the filter text typed in that tab", () => {
  assert.equal(openFilesPlace({ path: "src/a.ts", line: 4, filter: "按钮" }).filter, "按钮");
  assert.equal(openFilesPlace({ filter: "  lab " }).filter, "  lab ");
  assert.equal(openFilesPlace({ filter: 3 }).filter, "");
});

test("session and tree paths land on the same file tab", () => {
  assert.equal(canonicalOpenPath("C:/work/demo", "C:/work/demo/src/app.ts"), "src/app.ts");
  assert.equal(canonicalOpenPath("C:/work/demo", "src/app.ts"), "src/app.ts");
  assert.equal(canonicalOpenPath("C:/work/demo", "D:/other/notes.md"), "D:/other/notes.md");
  const first = openFileInPlace(
    { path: "", line: null, filter: "按钮", tabs: [] },
    "src/app.ts",
    2,
  );
  const second = openFileInPlace(first, "SRC/App.ts", 4);
  assert.equal(second.filter, "按钮");
  assert.equal(second.tabs.length, 1);
  assert.equal(second.path, "SRC/App.ts");
  assert.equal(second.line, 4);
  const added = openFileInPlace(second, "docs/readme.md", null);
  assert.deepEqual(
    added.tabs.map((tab) => tab.path),
    ["SRC/App.ts", "docs/readme.md"],
  );
  const selected = selectOpenFile(added, "src/app.ts");
  assert.equal(selected.path, "SRC/App.ts");
  assert.equal(selected.line, 4);
  const closed = closeOpenFile(selected, "src/app.ts");
  assert.equal(closed.path, "docs/readme.md");
  assert.deepEqual(closeOpenFile(closed, "docs/readme.md"), {
    path: "",
    line: null,
    filter: "按钮",
    tabs: [],
  });
});

test("switching projects in one session clears the open-files preview", () => {
  assert.equal(
    clearOpenFilesOnScope({ projectId: "a", sessionId: "s" }, { projectId: "b", sessionId: "s" }),
    true,
  );
  assert.equal(
    clearOpenFilesOnScope({ projectId: "a", sessionId: "s" }, { projectId: "a", sessionId: "other" }),
    false,
  );
  assert.equal(
    clearOpenFilesOnScope({ projectId: "a", sessionId: "s" }, { projectId: "a", sessionId: "s" }),
    false,
  );
});

test("the first file stays open and subsequent files share one preview slot", () => {
  let place = openFileInPlace(openFilesPlace(null), "a.ts", 3);
  assert.deepEqual(place.tabs, [{ path: "a.ts", line: 3 }]);
  place = openFileInPlace(place, "b.ts", 7);
  assert.deepEqual(place.tabs[1], { path: "b.ts", line: 7, preview: true });
  place = selectOpenFile(place, "a.ts");
  place = openFileInPlace(place, "c.ts", 9);
  assert.deepEqual(place.tabs, [
    { path: "a.ts", line: 3 }, { path: "c.ts", line: 9, preview: true },
  ]);
  place = openFilesPlace(place);
  assert.equal(place.tabs[1].preview, true);
  place = keepOpenFile(place, "C.ts");
  assert.deepEqual(place.tabs[1], { path: "c.ts", line: 9 });
  place = openFileInPlace(place, "d.ts", null);
  place = openFileInPlace(place, "c.ts", 12);
  assert.equal(place.tabs.length, 3);
  assert.equal(place.tabs[1].preview, undefined);
  assert.equal(place.tabs[1].line, 12);
  place = openFileInPlace(place, "e.ts", null);
  assert.deepEqual(place.tabs.map((tab) => tab.path), ["a.ts", "c.ts", "e.ts"]);
  assert.equal(place.tabs[2].preview, true);
  place = openFileInPlace(place, "e.ts", null, false);
  assert.equal(place.tabs[2].preview, undefined);
  place = openFileInPlace(place, "f.ts", null);
  assert.equal(place.tabs.length, 4);
});

test("closing previews and all files leaves no stale preview slot", () => {
  let place = openFileInPlace(openFilesPlace(null), "a.ts", null);
  place = openFileInPlace(place, "b.ts", null);
  place = closeOpenFile(place, "b.ts");
  place = openFileInPlace(place, "c.ts", null);
  assert.deepEqual(place.tabs.map((tab) => tab.path), ["a.ts", "c.ts"]);
  place = closeOpenFile(closeOpenFile(place, "a.ts"), "c.ts");
  place = openFileInPlace(place, "d.ts", null);
  assert.deepEqual(place.tabs, [{ path: "d.ts", line: null }]);
});
