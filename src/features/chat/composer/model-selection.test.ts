import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentCatalog, AgentModelOption } from "../../../types/index.ts";
import { modelInCatalog, pickModel } from "./model-selection.ts";

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
