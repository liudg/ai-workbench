import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentCatalog } from "../types.ts";
import {
  CATALOG_STALE_NOTICE,
  modelButtonLabel,
  preferCatalog,
  reduceCatalogResult,
} from "./catalog.ts";

function catalog(id: string, skills: string[] = []): AgentCatalog {
  return {
    models: [
      {
        id,
        label: id,
        description: "",
        is_default: true,
        default_effort: "medium",
        efforts: [],
      },
    ],
    skills: skills.map((mention) => ({
      name: mention,
      mention,
      label: mention,
      description: "",
      path: mention,
    })),
    commands: [],
    capabilities: {
      supports_slash: true,
      supports_resume: true,
      supports_questions: true,
      supports_tuning: true,
      supports_skills: true,
      supports_goals: true,
      supports_fork: true,
      supports_delete: true,
      supports_rename: true,
      supports_images: true,
      supports_queue: true,
      changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
    },
  };
}

test("timeout keeps the cached models and one muted notice", () => {
  const cached = catalog("gpt-cached", ["documents"]);
  const next = reduceCatalogResult(
    { cached, notice: null },
    { ok: false, message: "等待 Codex model/list 超时" },
  );
  const shown = preferCatalog(next.live, next.cached);
  assert.equal(shown?.models[0]?.id, "gpt-cached");
  assert.equal(shown?.skills[0]?.mention, "documents");
  assert.equal(next.notice, CATALOG_STALE_NOTICE);
  assert.equal(modelButtonLabel("gpt-cached · 中", shown, next.notice), "gpt-cached · 中");
  assert.notEqual(modelButtonLabel("gpt-cached · 中", shown, next.notice), "暂无模型");
});

test("empty refresh does not replace a previous catalog", () => {
  const cached = catalog("gpt-cached");
  const empty = { ...cached, models: [] };
  const next = reduceCatalogResult(
    { cached, notice: null },
    { ok: true, catalog: empty },
  );
  assert.equal(preferCatalog(next.live, next.cached)?.models[0]?.id, "gpt-cached");
  assert.equal(next.notice, CATALOG_STALE_NOTICE);
});

test("a failed skill refresh does not wipe skills that already arrived", () => {
  const cached = catalog("gpt-cached", ["documents"]);
  const incoming = catalog("gpt-cached");
  incoming.skills = [];
  incoming.skills_error = "等待 Codex skills/list 超时";
  const next = reduceCatalogResult({ cached, notice: null }, { ok: true, catalog: incoming });
  assert.equal(next.live?.skills[0]?.mention, "documents");
  assert.equal(next.live?.skills_error ?? null, null);
});

test("a failed skill refresh with no previous list stays empty and keeps the error", () => {
  const incoming = catalog("gpt-new");
  incoming.skills = [];
  incoming.skills_error = "等待 Codex skills/list 超时";
  const next = reduceCatalogResult({ notice: null }, { ok: true, catalog: incoming });
  assert.equal(next.live?.skills.length, 0);
  assert.equal(next.live?.skills_error, "等待 Codex skills/list 超时");
});

test("skills-only success still keeps the models that arrived with it", () => {
  const next = reduceCatalogResult(
    { notice: null },
    { ok: true, catalog: catalog("gpt-new", ["documents"]) },
  );
  assert.equal(next.live?.models[0]?.id, "gpt-new");
  assert.equal(next.cached?.skills.length, 1);
  assert.equal(next.notice, null);
});

test("failure without a cache is a notice and does not invent an empty catalog", () => {
  const next = reduceCatalogResult(
    { notice: null },
    { ok: false, message: "等待 Codex model/list 超时" },
  );
  assert.equal(next.live, undefined);
  assert.equal(next.notice, "等待 Codex model/list 超时");
  assert.equal(modelButtonLabel(undefined, undefined, next.notice), "暂无模型");
});

test("loading has neither a catalog nor a notice", () => {
  assert.equal(modelButtonLabel(undefined, undefined, null), "读取模型…");
});

test("composer prefers the cached list before the live refresh arrives", () => {
  const cached = catalog("gpt-cached");
  assert.equal(preferCatalog(undefined, cached)?.models[0]?.id, "gpt-cached");
});
