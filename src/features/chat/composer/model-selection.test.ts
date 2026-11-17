import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentCatalog, AgentModelOption } from "../../../types/index.ts";
import { composerModelStatus, modelInCatalog, pickModel } from "./model-selection.ts";

function model(patch: Partial<AgentModelOption> & Pick<AgentModelOption, "id" | "label">): AgentModelOption {
  return {
    description: "",
    is_default: false,
    default_effort: "high",
    efforts: [{ id: "high", description: "" }],
    ...patch,
  };
}

function catalog(models: AgentModelOption[], threadModel?: string): AgentCatalog {
  return {
    models,
    skills: [],
    commands: [],
    capabilities: {
      supports_slash: false,
      supports_resume: false,
      supports_questions: false,
      supports_tuning: true,
      supports_skills: false,
      changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
    },
    thread_model: threadModel ?? null,
    cli_config_read: true,
  };
}

const aliased = [
  model({
    id: "default",
    label: "Default (recommended)",
    resolved_model: "gpt-6.1-sol[1m]",
    efforts: [
      { id: "low", description: "" },
      { id: "high", description: "" },
    ],
  }),
  model({
    id: "opus",
    label: "gpt-6.1-sol",
    resolved_model: "gpt-6.1-sol",
  }),
];

test("a resolved name maps to the alias, and a bracket suffix does not steal it", () => {
  const listed = catalog(aliased);
  assert.equal(modelInCatalog(listed, "opus")?.id, "opus");
  assert.equal(modelInCatalog(listed, "gpt-6.1-sol")?.id, "opus");
  assert.equal(modelInCatalog(listed, "gpt-6.1-sol[1m]")?.id, "default");
  assert.equal(modelInCatalog(listed, "missing"), undefined);
  assert.equal(pickModel(catalog(aliased, "gpt-6.1-sol"), undefined)?.id, "opus");
  assert.equal(pickModel(catalog(aliased, "gpt-6.1-sol[1m]"), undefined)?.id, "default");
});

test("a configured model matches this catalog ignoring case and does not guess another default", () => {
  const listed = catalog([
    model({ id: "gpt-6.1-sol", label: "GPT-6.1-Sol", is_default: true }),
    model({ id: "gpt-5.4", label: "GPT-5.4" }),
  ]);
  listed.configured_model = "GPT-5.4";
  assert.equal(pickModel(listed, undefined)?.id, "gpt-5.4");
  assert.equal(modelInCatalog(listed, "GPT-5.4")?.id, "gpt-5.4");
  assert.equal(modelInCatalog(catalog(aliased), "GPT-6.1-SOL[1m]")?.id, "default");
  assert.equal(modelInCatalog(listed, "claude-opus"), undefined);
  const foreign = catalog([model({ id: "claude-sonnet", label: "Sonnet", is_default: true })]);
  foreign.configured_model = "gpt-6.1-sol";
  assert.equal(pickModel(foreign, { model: "gpt-6.1-sol", effort: "high" })?.id, "claude-sonnet");
});

test("composerModelStatus resolves tuned models from warm catalogs but waits on untuned sessions until settled", () => {
  const shared = catalog([
    model({ id: "claude-opus-5-5", label: "Claude Opus 5.5", is_default: true }),
    model({ id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" }),
  ]);

  // Tuned session resolves immediately from an agent-wide catalog before session catalog settles.
  assert.deepEqual(
    composerModelStatus({
      catalog: shared,
      catalogSettled: false,
      catalogNotice: null,
      tuning: { model: "gemini-4-hydrogen", effort: "high" },
    }),
    { modelLabel: "Gemini 4 Hydrogen", modelLoading: false },
  );

  // Untuned session does not guess another session's default before its own catalog settles.
  assert.deepEqual(
    composerModelStatus({
      catalog: shared,
      catalogSettled: false,
      catalogNotice: null,
      tuning: undefined,
    }),
    { modelLabel: null, modelLoading: true },
  );

  // Once the session's own catalog settles with its thread_model, untuned session resolves accurately.
  assert.deepEqual(
    composerModelStatus({
      catalog: catalog(shared.models, "gemini-4-hydrogen"),
      catalogSettled: true,
      catalogNotice: null,
      tuning: undefined,
    }),
    { modelLabel: "Gemini 4 Hydrogen", modelLoading: false },
  );

  // Draft / new session settles as soon as catalog or notice is present.
  assert.deepEqual(
    composerModelStatus({ catalog: undefined, catalogNotice: null, tuning: undefined }),
    { modelLabel: null, modelLoading: true },
  );
  assert.deepEqual(
    composerModelStatus({ catalog: undefined, catalogNotice: "暂无模型列表", tuning: undefined }),
    { modelLabel: null, modelLoading: false },
  );
});
