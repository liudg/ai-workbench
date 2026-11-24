import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AgentCapabilities,
  type AgentInstance,
  type AgentProfile,
} from "../../types/index.ts";
import {
  availableIsolationModes,
  createInstanceFormDraft,
  createTextGenDraft,
  draftToUpsertInput,
  filterTextGenCapableInstances,
  formatLaunchArgs,
  instanceToUpsertInput,
  isDefaultInstanceModified,
  parseLaunchArgs,
  textGenDraftToSettings,
  toggleEnvVarSensitive,
  updateEnvVarName,
  updateEnvVarValue,
  updateTextGenApiKey,
  updateTextGenBaseUrl,
} from "./instance-form.ts";

function caps(overrides: Partial<AgentCapabilities> = {}): AgentCapabilities {
  return {
    supports_slash: true,
    supports_resume: true,
    supports_questions: true,
    supports_tuning: true,
    supports_skills: true,
    changes: { turn_diff: true, per_file_patch: true, git_scopes: true },
    ...overrides,
  };
}

test("availableIsolationModes gates shadowHome strictly on capabilities.supports_shadow_home", () => {
  const withoutShadow = availableIsolationModes(caps({ supports_shadow_home: false }));
  assert.deepEqual(
    withoutShadow.map((m) => m.id),
    ["hostDefault", "isolatedHome"],
  );

  // Even for non-codex agent, if adapter declares supports_shadow_home: true, UI offers it
  const withShadow = availableIsolationModes(caps({ supports_shadow_home: true }));
  assert.deepEqual(
    withShadow.map((m) => m.id),
    ["hostDefault", "isolatedHome", "shadowHome"],
  );
});

test("InstanceFormDraft preserves redacted secrets on unrelated edits and updates cleanly when modified", () => {
  const existing: AgentInstance = {
    id: "claude-gateway",
    kind: "claude-code",
    displayName: "Claude 网关",
    accentColor: "#10b981",
    binaryPath: null,
    launchArgs: ["--verbose"],
    environment: [
      {
        name: "ANTHROPIC_BASE_URL",
        value: "https://gateway.example.com",
        sensitive: false,
      },
      {
        name: "ANTHROPIC_API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
    ],
    isolationMode: "isolatedHome",
    homePath: null,
    sharedHomePath: null,
    enabled: true,
    isDefault: false,
    sortOrder: 100,
    createdAt: 1000,
    updatedAt: 1000,
  };

  const draft = createInstanceFormDraft({
    kind: "claude-code",
    instance: existing,
    capabilities: caps({ supports_shadow_home: false }),
  });
  assert.equal(draft.environment[1]?.value, "");
  assert.equal(draft.environment[1]?.valueRedacted, true);
  assert.ok(draft.environment[0]?.id !== draft.environment[1]?.id);

  // Edit displayName only -> redacted secret stays marked valueRedacted: true with empty value
  const renamed = draftToUpsertInput(
    { ...draft, displayName: "Claude 企业网关" },
    caps({ supports_shadow_home: false }),
  );
  assert.equal(renamed.displayName, "Claude 企业网关");
  assert.deepEqual(renamed.environment, [
    {
      name: "ANTHROPIC_BASE_URL",
      value: "https://gateway.example.com",
      sensitive: false,
    },
    {
      name: "ANTHROPIC_API_KEY",
      value: "",
      sensitive: true,
      valueRedacted: true,
    },
  ]);

  // Renaming the env var clears valueRedacted so old secret does not pretend to apply,
  // EXCEPT if the user fixes a temporary typo back to sourceName before saving!
  const renamedEnvRow = updateEnvVarName(draft.environment[1]!, "OPENAI_API_KEY");
  assert.equal(renamedEnvRow.value, "");
  assert.equal(renamedEnvRow.hadSavedSecret, true);
  assert.equal(renamedEnvRow.valueRedacted, false);
  const renamedEnvSerialized = draftToUpsertInput(
    { ...draft, environment: [draft.environment[0]!, renamedEnvRow] },
    caps({ supports_shadow_home: false }),
  );
  assert.deepEqual(renamedEnvSerialized.environment?.[1], {
    name: "OPENAI_API_KEY",
    value: "",
    sensitive: true,
  });

  // Reverting typo back to ANTHROPIC_API_KEY restores valueRedacted: true!
  const revertedEnvRow = updateEnvVarName(renamedEnvRow, "  ANTHROPIC_API_KEY ");
  assert.equal(revertedEnvRow.valueRedacted, true);
  const revertedSerialized = draftToUpsertInput(
    { ...draft, environment: [draft.environment[0]!, revertedEnvRow] },
    caps({ supports_shadow_home: false }),
  );
  assert.deepEqual(revertedSerialized.environment?.[1], {
    name: "ANTHROPIC_API_KEY",
    value: "",
    sensitive: true,
    valueRedacted: true,
  });

  // Overwrite secret with a new key -> hadSavedSecret and valueRedacted cleared
  const updatedEnv = draft.environment.slice();
  updatedEnv[1] = updateEnvVarValue(updatedEnv[1]!, "sk-ant-new-secret");
  assert.equal(updatedEnv[1]?.hadSavedSecret, false);
  const overwritten = draftToUpsertInput(
    { ...draft, environment: updatedEnv },
    caps({ supports_shadow_home: false }),
  );
  assert.deepEqual(overwritten.environment?.[1], {
    name: "ANTHROPIC_API_KEY",
    value: "sk-ant-new-secret",
    sensitive: true,
  });

  // Turning off sensitive on a redacted secret clears hadSavedSecret and valueRedacted
  const untoggled = toggleEnvVarSensitive(draft.environment[1]!, false);
  assert.equal(untoggled.sensitive, false);
  assert.equal(untoggled.value, "");
  assert.equal(untoggled.hadSavedSecret, false);
  assert.equal(untoggled.valueRedacted, false);
  assert.equal(toggleEnvVarSensitive(untoggled, true).valueRedacted, false);

  // Toggling enabled from row preserves redacted secrets with empty value
  const toggled = instanceToUpsertInput(existing, false);
  assert.equal(toggled.enabled, false);
  assert.deepEqual(toggled.environment?.[1], {
    name: "ANTHROPIC_API_KEY",
    value: "",
    sensitive: true,
    valueRedacted: true,
  });
});

test("formatLaunchArgs and parseLaunchArgs round-trip single space/quote args and multiline args", () => {
  assert.deepEqual(parseLaunchArgs("  --profile work \"C:\\My Dir\\cfg.json\" "), [
    "--profile",
    "work",
    "C:\\My Dir\\cfg.json",
  ]);
  assert.deepEqual(parseLaunchArgs("--profile\nC:\\My Dir\\cfg.json\n"), [
    "--profile",
    "C:\\My Dir\\cfg.json",
  ]);
  assert.deepEqual(parseLaunchArgs("--config\n\"C:\\My Folder\\cfg.toml\"\n'D:\\Other Dir\\a.json'"), [
    "--config",
    "C:\\My Folder\\cfg.toml",
    "D:\\Other Dir\\a.json",
  ]);

  for (const sample of [
    ["C:\\My Folder\\cfg.toml"],
    ['--filter="hello world"'],
    ["--filter='hello world'"],
    ['say "it\'s ok"'],
    ["--verbose"],
    ["--config", "C:\\My Folder\\cfg.toml"],
  ]) {
    assert.deepEqual(parseLaunchArgs(formatLaunchArgs(sample)), sample);
  }
});

test("TextGenFormDraft preserves apiKeyRedacted, clears on baseUrl change, and filters instances by supports_text_generation", () => {
  const draft = createTextGenDraft({
    mode: "http",
    autoTitle: true,
    http: {
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "",
      apiKeyRedacted: true,
      model: "claude-haiku-4-5",
    },
  });
  assert.equal(draft.apiKey, "");
  assert.equal(draft.apiKeyRedacted, true);

  // Toggling autoTitle or switching mode preserves redacted HTTP key with empty apiKey
  const saved = textGenDraftToSettings({ ...draft, autoTitle: false });
  assert.equal(saved.autoTitle, false);
  assert.equal(saved.http?.apiKey, "");
  assert.equal(saved.http?.apiKeyRedacted, true);

  // Changing baseUrl clears apiKeyRedacted so old endpoint's secret isn't assumed,
  // EXCEPT reverting baseUrl (including trailing-slash difference) restores apiKeyRedacted!
  const urlChanged = updateTextGenBaseUrl(draft, "https://proxy.example.com/v1");
  assert.equal(urlChanged.apiKey, "");
  assert.equal(urlChanged.hadSavedApiKey, true);
  assert.equal(urlChanged.apiKeyRedacted, false);
  const savedAfterUrlChange = textGenDraftToSettings(urlChanged);
  assert.equal(savedAfterUrlChange.http?.apiKey, "");
  assert.equal(savedAfterUrlChange.http?.apiKeyRedacted, undefined);

  const urlRevertedWithSlash = updateTextGenBaseUrl(urlChanged, "  https://api.anthropic.com/ ");
  assert.equal(urlRevertedWithSlash.apiKeyRedacted, true);
  const savedAfterUrlRevert = textGenDraftToSettings(urlRevertedWithSlash);
  assert.equal(savedAfterUrlRevert.http?.apiKey, "");
  assert.equal(savedAfterUrlRevert.http?.apiKeyRedacted, true);

  // Updating key sends new value without apiKeyRedacted
  const updated = textGenDraftToSettings(updateTextGenApiKey(draft, "sk-fresh"));
  assert.equal(updated.http?.apiKey, "sk-fresh");
  assert.equal(updated.http?.apiKeyRedacted, undefined);

  // Capability filtering
  const instances: AgentInstance[] = [
    {
      id: "agent-a",
      kind: "claude-code",
      displayName: "Capable Instance",
      isolationMode: "hostDefault",
      enabled: true,
      isDefault: false,
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: "agent-b",
      kind: "opencode",
      displayName: "Non-Capable Instance",
      isolationMode: "hostDefault",
      enabled: true,
      isDefault: true,
      sortOrder: 1,
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  const profiles: Partial<Record<string, AgentProfile>> = {
    "agent-a": {
      kind: "claude-code",
      instance_id: "agent-a",
      capabilities: caps({ supports_text_generation: true }),
      commands: [],
    },
    "agent-b": {
      kind: "opencode",
      instance_id: "agent-b",
      capabilities: caps({ supports_text_generation: false }),
      commands: [],
    },
  };
  const filtered = filterTextGenCapableInstances(instances, profiles);
  assert.deepEqual(filtered.map((i) => i.id), ["agent-a"]);

  assert.equal(
    isDefaultInstanceModified({
      id: "claude-code",
      kind: "claude-code",
      displayName: "Claude Code",
      isolationMode: "hostDefault",
      enabled: true,
      isDefault: true,
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    }),
    false,
  );
  assert.equal(
    isDefaultInstanceModified({
      id: "claude-code",
      kind: "claude-code",
      displayName: "Claude Custom",
      isolationMode: "hostDefault",
      enabled: true,
      isDefault: true,
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 100,
    }),
    true,
  );
});
