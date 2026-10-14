import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentCatalog, AgentModelOption } from "../../../types/index.ts";
import { effortDisplay } from "./effort-label.ts";
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

test("the slider keeps every catalog effort in order", () => {
  const current = model({
    id: "gpt",
    label: "GPT",
    default_effort: "medium",
    efforts: [
      { id: "low", description: "Lower latency" },
      { id: "medium", description: "" },
      { id: "high", description: "" },
      { id: "xhigh", description: "" },
      { id: "max", description: "" },
      { id: "ultra", description: "" },
    ],
  });
  assert.deepEqual(
    sliderEfforts(current).map((effort) => effort.id),
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );
  const short = model({
    id: "two",
    label: "Two",
    efforts: [
      { id: "low", description: "快" },
      { id: "high", description: "深" },
    ],
  });
  assert.deepEqual(
    sliderEfforts(short).map((effort) => effort.id),
    ["low", "high"],
  );
  assert.deepEqual(sliderEfforts(model({ id: "empty", label: "Empty", default_effort: "high" })), []);
  assert.equal(effortDisplay(current, "low"), "低");
  assert.equal(effortDisplay(model({ id: "named", label: "Named", efforts: [{ id: "high", description: "long", label: "高" }] }), "high"), "高");
  assert.equal(effortDisplay(current, "missing"), "");
  assert.equal(
    effortDisplay(
      model({
        id: "top",
        label: "Top",
        efforts: [
          {
            id: "xhigh",
            description: "Maximum reasoning effort for the hardest problems",
            label: "Maximum reasoning",
          },
        ],
      }),
      "xhigh",
    ),
    "很高",
  );
  assert.equal(
    effortDisplay(model({ id: "maxed", label: "Max", efforts: [{ id: "max", description: "Maximum reasoning" }] }), "max"),
    "最高",
  );
  assert.equal(effortDisplay(model({ id: "ultra", label: "Ultra", efforts: [{ id: "ultra", description: "" }] }), "ultra"), "极高");
  assert.equal(
    effortDisplay(model({ id: "min", label: "Min", efforts: [{ id: "minimal", description: "Minimal reasoning" }] }), "minimal"),
    "最低",
  );
  assert.equal(
    effortDisplay(
      model({
        id: "custom",
        label: "Custom",
        efforts: [{ id: "research", description: "Maximum reasoning effort for research", label: "Maximum reasoning" }],
      }),
      "research",
    ),
    "research",
  );
  assert.equal(
    effortDisplay(
      model({
        id: "custom-han",
        label: "Custom",
        efforts: [{ id: "research", description: "long english", label: "深研" }],
      }),
      "research",
    ),
    "深研",
  );
});

test("the handle snaps to the nearest of five stops", () => {
  assert.equal(snapEffortIndex(0, 0, 100, 5), 0);
  assert.equal(snapEffortIndex(100, 0, 100, 5), 4);
  assert.equal(snapEffortIndex(50, 0, 100, 5), 2);
  assert.equal(snapEffortIndex(20, 0, 100, 5), 1);
  assert.equal(snapEffortIndex(10, 0, 0, 5), 0);
});

test("the chip is the model name and the effort text already resolved", () => {
  assert.equal(modelChipText("Sonnet", "更深"), "Sonnet 更深");
  assert.equal(modelChipText("GPT-6 Astra", "high"), "GPT-6 Astra high");
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
  const unmarked = model({
    id: "named-fast",
    label: "Named",
    service_tiers: [{ id: "fast", name: "Fast", description: "1.5x" }],
  });
  const fast = model({
    id: "gpt",
    label: "GPT",
    service_tiers: [{ id: "priority", name: "Priority", description: "优先", fast: true }],
    default_service_tier: null,
  });
  assert.equal(supportsFast(plain), false);
  assert.equal(supportsFast(unmarked), false);
  assert.equal(supportsFast(fast), true);
  const fastCatalog = { ...catalog, configured_service_tier: "priority" };
  assert.equal(baselineServiceTier(fast, fastCatalog), "priority");
  assert.equal(baselineServiceTier(plain, fastCatalog), null);
  assert.equal(effectiveServiceTier(fast, { model: "gpt", effort: "high", serviceTier: null }, fastCatalog), null);
  assert.equal(effectiveServiceTier(fast, { model: "gpt", effort: "high" }, fastCatalog), "priority");
  assert.equal(tuningForModel(plain, "high", "priority").serviceTier, null);
  assert.equal(tuningForModel(fast, "low", "priority").serviceTier, "priority");
  assert.equal(tuningForModel(fast, "low", undefined).serviceTier, undefined);
});
