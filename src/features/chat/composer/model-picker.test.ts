import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentCatalog, AgentModelOption } from "../../../types/index.ts";
import {
  baselineServiceTier,
  effectiveServiceTier,
  modelChipText,
  modelSections,
  sliderEfforts,
  snapEffortIndex,
  supportsFast,
  tuningForModel,
} from "./model-picker.ts";

function model(patch: Partial<AgentModelOption> & Pick<AgentModelOption, "id" | "label">): AgentModelOption {
  return {
    description: "",
    is_default: false,
    default_effort: "medium",
    efforts: [],
    ...patch,
  };
}

const catalog = {
  models: [],
  skills: [],
  commands: [],
  capabilities: {
    supports_slash: true,
    supports_resume: false,
    supports_questions: false,
    supports_tuning: true,
    supports_skills: false,
    changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
  },
  configured_service_tier: "fast",
} satisfies AgentCatalog;

test("the slider keeps catalog order and leaves max and ultra off the normal scale", () => {
  const current = model({
    id: "gpt",
    label: "GPT",
    default_effort: "medium",
    efforts: [
      { id: "low", description: "" },
      { id: "medium", description: "" },
      { id: "high", description: "" },
      { id: "xhigh", description: "" },
      { id: "max", description: "" },
      { id: "ultra", description: "" },
    ],
  });
  assert.deepEqual(
    sliderEfforts(current).map((effort) => effort.id),
    ["low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    sliderEfforts(model({ id: "only", label: "Only", efforts: [{ id: "max", description: "" }] })).map(
      (effort) => effort.id,
    ),
    ["max"],
  );
  assert.deepEqual(sliderEfforts(model({ id: "empty", label: "Empty", default_effort: "high" })).map((e) => e.id), [
    "high",
  ]);
});

test("the handle snaps to the nearest of five stops", () => {
  assert.equal(snapEffortIndex(0, 0, 100, 5), 0);
  assert.equal(snapEffortIndex(100, 0, 100, 5), 4);
  assert.equal(snapEffortIndex(50, 0, 100, 5), 2);
  assert.equal(snapEffortIndex(20, 0, 100, 5), 1);
  assert.equal(snapEffortIndex(10, 0, 0, 5), 0);
});

test("the chip is the model name and the effort word", () => {
  assert.equal(modelChipText("GPT-6 Astra", "xhigh"), "GPT-6 Astra 极高");
  assert.equal(modelChipText("GPT-6 Astra", "high"), "GPT-6 Astra 高");
  assert.equal(modelChipText("GPT-6 Astra", undefined), "GPT-6 Astra");
});

test("models split into the default and the recommended set", () => {
  const sections = modelSections([
    model({ id: "hidden", label: "Hidden", show_in_picker: false, is_default: true }),
    model({ id: "sol", label: "GPT-6.1 Sol", is_default: true }),
    model({ id: "astra", label: "GPT-6 Astra" }),
    model({ id: "luna", label: "GPT-6 Luna" }),
  ]);
  assert.deepEqual(
    sections.map((section) => [section.title, section.models.map((item) => item.id)]),
    [
      ["默认", ["sol"]],
      ["推荐模型集", ["astra", "luna"]],
    ],
  );
});

test("fast mode follows the catalog tier and an explicit off switch", () => {
  const plain = model({ id: "plain", label: "Plain" });
  const fast = model({
    id: "gpt",
    label: "GPT",
    service_tiers: [{ id: "fast", name: "Fast", description: "" }],
    default_service_tier: null,
  });
  assert.equal(supportsFast(plain), false);
  assert.equal(supportsFast(fast), true);
  assert.equal(baselineServiceTier(fast, catalog), "fast");
  assert.equal(baselineServiceTier(plain, catalog), null);
  assert.equal(effectiveServiceTier(fast, { model: "gpt", effort: "high", serviceTier: null }, catalog), null);
  assert.equal(effectiveServiceTier(fast, { model: "gpt", effort: "high" }, catalog), "fast");
  assert.equal(tuningForModel(plain, "high", "fast").serviceTier, null);
  assert.equal(tuningForModel(fast, "low", "fast").serviceTier, "fast");
  assert.equal(tuningForModel(fast, "low", undefined).serviceTier, undefined);
});
