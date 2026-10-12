import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFileTree, directoryIds } from "./file-tree.ts";

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
