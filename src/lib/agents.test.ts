import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentInstallation, AgentKind } from "../types/index.ts";
import {
  installedAgents,
  sessionAgents,
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
  assert.deepEqual(sessionAgents([row("codex-cli", false, true)]), []);
});

test("empty detection does not invent a default agent", () => {
  assert.deepEqual(installedAgents(null), []);
  assert.deepEqual(sessionAgents(undefined), []);
  assert.deepEqual(sessionAgents([row("claude-code", true, false)]), []);
});
