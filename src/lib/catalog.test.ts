import assert from "node:assert/strict";
import { test } from "node:test";

import { modelButtonLabel } from "./catalog.ts";

test("the selected model wins, a known-empty catalog or a notice says there are none", () => {
  assert.equal(modelButtonLabel("gpt · 中", undefined, "刷新失败"), "gpt · 中");
  assert.equal(modelButtonLabel(undefined, undefined, "刷新失败"), "暂无模型");
  assert.equal(
    modelButtonLabel(undefined, { models: [], skills: [], commands: [], capabilities: {} } as never, null),
    "暂无模型",
  );
});

test("still loading shows neither a model nor 暂无模型", () => {
  assert.equal(modelButtonLabel(undefined, undefined, null), "读取模型…");
});
