import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentCatalog } from "../types/index.ts";
import { modelButtonLabel, storedThenProbed } from "./catalog.ts";

function named(id: string): AgentCatalog {
  return { models: [{ id }], skills: [], commands: [], capabilities: {} } as never;
}

async function shownBy(stored: Promise<AgentCatalog | null>, probed: Promise<AgentCatalog>) {
  const shown: string[] = [];
  const outcome = await storedThenProbed(stored, probed, (catalog) => shown.push(catalog.models[0].id)).then(
    () => "ok",
    (error: unknown) => String(error),
  );
  return { shown, outcome };
}

test("the stored catalog shows first and the probed one replaces it", async () => {
  const probed = new Promise<AgentCatalog>((resolve) => setTimeout(() => resolve(named("fresh")), 5));
  assert.deepEqual(await shownBy(Promise.resolve(named("stored")), probed), { shown: ["stored", "fresh"], outcome: "ok" });
});

test("a stored catalog that arrives after the probed one is dropped", async () => {
  const stored = new Promise<AgentCatalog | null>((resolve) => setTimeout(() => resolve(named("stored")), 5));
  const result = await shownBy(stored, Promise.resolve(named("fresh")));
  await stored;
  assert.deepEqual(result, { shown: ["fresh"], outcome: "ok" });
});

test("a failed probe keeps the stored catalog; with nothing stored it rejects", async () => {
  const failing = () => Promise.reject<AgentCatalog>("超时");
  assert.deepEqual(await shownBy(Promise.resolve(named("stored")), failing()), { shown: ["stored"], outcome: "ok" });
  assert.deepEqual(await shownBy(Promise.resolve(null), failing()), { shown: [], outcome: "超时" });
  assert.deepEqual(await shownBy(Promise.reject("断线"), failing()), { shown: [], outcome: "超时" });
});

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
