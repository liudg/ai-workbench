import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentInstallation, AgentKind } from "../types.ts";
import { installedAgents, keepPreferredAgent, persistedAgentKind } from "./agents.ts";

function row(kind: AgentKind, installed: boolean, name: string = kind): AgentInstallation {
  return {
    kind,
    display_name: name,
    installed,
    version: installed ? "1.0.0" : null,
    latest_version: null,
    update_available: false,
    update_via: null,
    detail: null,
  };
}

const registry = [
  row("codex-cli", false, "Codex CLI"),
  row("claude-code", true, "Claude Code"),
  row("cursor-agent", false, "Cursor Agent"),
  row("copilot-cli", true, "GitHub Copilot CLI"),
];

test("new session choices are only agents the detection list marks installed", () => {
  assert.deepEqual(
    installedAgents(registry).map((item) => item.kind),
    ["claude-code", "copilot-cli"],
  );
});

test("empty detection does not invent a default agent", () => {
  assert.deepEqual(installedAgents(null), []);
  assert.deepEqual(installedAgents(undefined), []);
  assert.deepEqual(installedAgents([]), []);
  assert.deepEqual(
    installedAgents([row("codex-cli", false), row("claude-code", false)]).map((item) => item.kind),
    [],
  );
  assert.equal(persistedAgentKind([], null), null);
  assert.equal(persistedAgentKind(null, "codex-cli"), null);
  assert.equal(
    persistedAgentKind([row("codex-cli", false), row("claude-code", false)], "codex-cli"),
    null,
  );
});

test("preferred agent is kept only when that install was detected", () => {
  assert.equal(persistedAgentKind(registry, "copilot-cli"), "copilot-cli");
  assert.equal(persistedAgentKind(registry, "codex-cli"), "claude-code");
  assert.equal(keepPreferredAgent("cursor-agent", registry), null);
  assert.equal(keepPreferredAgent("claude-code", registry), "claude-code");
});
