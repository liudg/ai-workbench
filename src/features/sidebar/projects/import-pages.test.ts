import assert from "node:assert/strict";
import { test } from "node:test";

import type { ImportCandidate } from "@/features/tasks";
import { countLabel, defaultAgent, mergeItems, NO_PAGES, withoutKeys } from "./import-pages.ts";

function item(agent: ImportCandidate["agent"], nativeId: string, updatedAt: number): ImportCandidate {
  return { agent, nativeId, title: nativeId, createdAt: updatedAt, updatedAt };
}

test("下一页接在后面，重复的只留一条，从新到旧", () => {
  const merged = mergeItems(
    [item("claude-code", "a", 30), item("claude-code", "b", 10)],
    [item("claude-code", "b", 10), item("claude-code", "c", 20)],
  );
  assert.deepEqual(
    merged.map((entry) => entry.nativeId),
    ["a", "c", "b"],
  );
});

test("标签上的数：还有下一页时带加号，第一页没回来时不给", () => {
  assert.equal(countLabel(undefined), null);
  assert.equal(countLabel({ ...NO_PAGES, loading: true }), null);
  const items = [item("codex-cli", "a", 1)];
  assert.equal(countLabel({ ...NO_PAGES, loaded: true, items, cursor: "next" }), "1+");
  assert.equal(countLabel({ ...NO_PAGES, loaded: true, items }), "1");
});

test("默认打开最近用过的 Agent，都没读到时是第一个", () => {
  const sources = ["codex-cli", "claude-code"] as const;
  assert.equal(defaultAgent([...sources], {}), "codex-cli");
  assert.equal(
    defaultAgent([...sources], {
      "codex-cli": { ...NO_PAGES, loaded: true, items: [item("codex-cli", "a", 5)] },
      "claude-code": { ...NO_PAGES, loaded: true, items: [item("claude-code", "b", 9)] },
    }),
    "claude-code",
  );
  assert.equal(defaultAgent([], {}), null);
});

test("导入成功的从各自的列表里拿掉", () => {
  const next = withoutKeys(
    {
      "codex-cli": { ...NO_PAGES, loaded: true, items: [item("codex-cli", "a", 1), item("codex-cli", "b", 2)] },
    },
    new Set(["codex-cli:a"]),
  );
  assert.deepEqual(
    next["codex-cli"]?.items.map((entry) => entry.nativeId),
    ["b"],
  );
});
