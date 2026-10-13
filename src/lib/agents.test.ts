import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentInstallation, AgentKind } from "../types/index.ts";
import {
  immediateSessionAgent,
  installedAgents,
  keepPreferredAgent,
  newSessionMenu,
  persistedAgentKind,
  sessionAgents,
  unlinkedAgents,
} from "./agents.ts";

function row(
  kind: AgentKind,
  installed: boolean,
  linked: boolean,
  name: string = kind,
): AgentInstallation {
  return {
    kind,
    display_name: name,
    installed,
    version: installed ? "1.0.0" : null,
    latest_version: null,
    update_available: false,
    update_via: null,
    detail: null,
    session_linked: linked,
  };
}

const registry = [
  row("codex-cli", true, true, "Codex CLI"),
  row("claude-code", true, false, "Claude Code"),
  row("cursor-agent", false, false, "Cursor Agent"),
  row("kimi-code", true, false, "Kimi Code"),
];

test("installed agents follow the detection list", () => {
  assert.deepEqual(
    installedAgents(registry).map((item) => item.kind),
    ["codex-cli", "claude-code", "kimi-code"],
  );
});

test("only installed and session-linked agents can open a session", () => {
  assert.deepEqual(sessionAgents(registry).map((item) => item.kind), ["codex-cli"]);
  assert.deepEqual(
    unlinkedAgents(registry).map((item) => item.kind),
    ["claude-code", "kimi-code"],
  );
  assert.deepEqual(sessionAgents([row("codex-cli", false, true)]), []);
});

test("empty detection does not invent a default agent", () => {
  assert.deepEqual(installedAgents(null), []);
  assert.deepEqual(sessionAgents(undefined), []);
  assert.equal(persistedAgentKind([], null), null);
  assert.equal(persistedAgentKind(null, "codex-cli"), null);
  assert.equal(
    persistedAgentKind([row("claude-code", true, false)], "claude-code"),
    null,
  );
});

test("the new-session menu hides agents that are installed but not linked", () => {
  assert.deepEqual(newSessionMenu(null), { status: "loading" });
  assert.deepEqual(newSessionMenu(undefined), { status: "loading" });
  assert.deepEqual(newSessionMenu([]), { status: "empty", reason: "none" });
  assert.deepEqual(newSessionMenu([row("claude-code", true, false, "Claude Code")]), {
    status: "empty",
    reason: "unwired",
  });
  assert.deepEqual(newSessionMenu([row("cursor-agent", false, false)]), {
    status: "empty",
    reason: "none",
  });
  const ready = newSessionMenu(registry);
  assert.equal(ready.status, "ready");
  if (ready.status === "ready") {
    assert.deepEqual(
      ready.agents.map((item) => item.kind),
      ["codex-cli"],
    );
    assert.equal(
      ready.agents.some((item) => item.session_linked !== true),
      false,
    );
  }
  assert.equal(immediateSessionAgent(registry), "codex-cli");
  assert.equal(immediateSessionAgent([row("codex-cli", true, true)]), "codex-cli");
  assert.equal(
    immediateSessionAgent([
      row("codex-cli", true, true),
      row("claude-code", true, false),
    ]),
    "codex-cli",
  );
});

test("preferred agent is kept only when it can open sessions", () => {
  assert.equal(persistedAgentKind(registry, "codex-cli"), "codex-cli");
  assert.equal(persistedAgentKind(registry, "kimi-code"), "codex-cli");
  assert.equal(keepPreferredAgent("claude-code", registry), "codex-cli");
  assert.equal(keepPreferredAgent("codex-cli", registry), "codex-cli");
  assert.equal(keepPreferredAgent(null, [row("claude-code", true, false)]), null);
});
