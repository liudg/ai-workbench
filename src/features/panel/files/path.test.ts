import assert from "node:assert/strict";
import { test } from "node:test";

import { workspaceRootLabel } from "./path.ts";

test("open-files root label is the drive letter", () => {
  assert.equal(workspaceRootLabel("F:\\sample\\mercury_dev"), "F:");
  assert.equal(workspaceRootLabel("C:/work/app"), "C:");
  assert.equal(workspaceRootLabel("/home/project"), "");
});
