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
    session_linked: installed,
  };
}

const registry = [
  row("codex-cli", false, "Codex CLI"),
  row("claude-code", true, "Claude Code"),
  row("cursor-agent", false, "Cursor Agent"),
  row("kimi-code", true, "Kimi Code"),
];

test("new session choices are only agents the detection list marks installed", () => {
  assert.deepEqual(
    installedAgents(registry).map((item) => item.kind),
    ["claude-code", "kimi-code"],
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
  assert.equal(persistedAgentKind(registry, "kimi-code"), "kimi-code");
  assert.equal(persistedAgentKind(registry, "codex-cli"), "claude-code");
  assert.equal(keepPreferredAgent("cursor-agent", registry), null);
  assert.equal(keepPreferredAgent("claude-code", registry), "claude-code");
});
