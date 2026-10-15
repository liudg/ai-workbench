import assert from "node:assert/strict";
import { test } from "node:test";

import { pathCrumb, workspaceRootLabel } from "./path.ts";

test("open-files root label is the drive letter", () => {
  assert.equal(workspaceRootLabel("F:\\sample\\mercury_dev"), "F:");
  assert.equal(workspaceRootLabel("C:/work/app"), "C:");
  assert.equal(workspaceRootLabel("/home/project"), "");
});

test("preview titles space the path separators", () => {
  assert.equal(pathCrumb("Scripts/GameUI/Module/GemRedDot.cs"), "Scripts / GameUI / Module / GemRedDot.cs");
  assert.equal(pathCrumb("src\\core\\A.ts"), "src / core / A.ts");
});
