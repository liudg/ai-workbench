import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFileTree, directoryIds, treePathLabel } from "./file-tree.ts";

test("nests files the way an assets folder does and sums change counts", () => {
  const tree = buildFileTree([
    { path: "README.md", added: 1, removed: 0 },
    { path: "Assets/Scripts/B.cs", added: 2, removed: 1 },
    { path: "Assets\\Scripts\\A.cs", added: 4, removed: 0 },
    { path: "Assets/Readme.md", added: 3, removed: 2 },
  ]);
  assert.deepEqual(
    tree.map((node) => node.name),
    ["Assets", "README.md"],
  );
  const assets = tree[0];
  assert.equal(assets.kind, "dir");
  assert.equal(assets.count, 3);
  assert.equal(assets.added, 9);
  assert.equal(assets.removed, 3);
  assert.deepEqual(
    assets.children.map((node) => `${node.kind}:${node.name}:${node.count}`),
    ["dir:Scripts:2", "file:Readme.md:1"],
  );
  assert.deepEqual(
    assets.children[0].children.map((node) => node.name),
    ["A.cs", "B.cs"],
  );
  assert.deepEqual(directoryIds(tree), ["Assets", "Assets/Scripts"]);
});

test("a single-child directory chain becomes one path with the file count", () => {
  const tree = buildFileTree([
    { path: "src/features/panel/files/A.ts", added: 2, removed: 1 },
    { path: "src/features/panel/files/B.ts", added: 4, removed: 0 },
  ]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].kind, "dir");
  assert.equal(tree[0].name, "src/features/panel/files");
  assert.equal(treePathLabel(tree[0].name), "src / features / panel / files");
  assert.equal(tree[0].path, "src/features/panel/files");
  assert.equal(tree[0].count, 2);
  assert.equal(tree[0].added, 6);
  assert.equal(tree[0].removed, 1);
  assert.deepEqual(
    tree[0].children.map((node) => node.name),
    ["A.ts", "B.ts"],
  );
});
