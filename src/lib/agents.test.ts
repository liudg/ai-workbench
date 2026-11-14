import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentInstallation, AgentKind } from "../types/index.ts";
import {
  installedAgents,
  readyAgentCount,
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

test("an agent is ready once its catalog probe succeeded", () => {
  const agents = [row("codex-cli", true, true), row("claude-code", true, true)];
  const probe = (kind: AgentKind, status: "probing" | "ready" | "failed") => ({ kind, status, error: null });
  assert.equal(readyAgentCount(null, []), null);
  assert.equal(readyAgentCount(agents, undefined), null);
  assert.equal(readyAgentCount(agents, [probe("codex-cli", "probing")]), null);
  assert.equal(readyAgentCount(agents, [probe("codex-cli", "ready"), probe("claude-code", "probing")]), 1);
  assert.equal(readyAgentCount(agents, [probe("codex-cli", "ready"), probe("claude-code", "failed")]), 1);
  assert.equal(readyAgentCount(agents, [probe("codex-cli", "failed"), probe("claude-code", "failed")]), 0);
  // 另一个还没有结果：先按已经就绪的算。
  assert.equal(readyAgentCount(agents, [probe("codex-cli", "ready")]), 1);
  assert.equal(readyAgentCount(agents, [probe("codex-cli", "failed")]), null);
  // 没装的 Agent 探过也不算。
  assert.equal(readyAgentCount([], [probe("codex-cli", "ready")]), 0);
});

test("empty detection does not invent a default agent", () => {
  assert.deepEqual(installedAgents(null), []);
  assert.deepEqual(sessionAgents(undefined), []);
  assert.deepEqual(sessionAgents([row("claude-code", true, false)]), []);
});
