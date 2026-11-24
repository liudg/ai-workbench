import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentCatalog, AgentInstallation, AgentKind } from "../types/index.ts";
import {
  findCatalogProbe,
  installedAgents,
  matchingInstanceCatalog,
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
  // 同种 Agent 默认实例探测失败时，已就绪的自定义实例不会被遮蔽。
  assert.equal(
    readyAgentCount(
      [{ kind: "claude-code", instance_id: "claude-work" }],
      [
        { kind: "claude-code", status: "failed", error: "not logged in" },
        { kind: "claude-code", instance_id: "claude-work", status: "ready", error: null },
      ],
    ),
    1,
  );
});

test("empty detection does not invent a default agent", () => {
  assert.deepEqual(installedAgents(null), []);
  assert.deepEqual(sessionAgents(undefined), []);
  assert.deepEqual(sessionAgents([row("claude-code", true, false)]), []);
});

test("findCatalogProbe and matchingInstanceCatalog isolate default vs custom instances", () => {
  const probes = [
    { kind: "codex-cli" as const, status: "ready" as const, error: null },
    { kind: "codex-cli" as const, instance_id: "codex-work", status: "failed" as const, error: "bad key" },
  ];
  assert.equal(findCatalogProbe(probes, "codex-cli")?.status, "ready");
  assert.equal(findCatalogProbe(probes, "codex-cli", "codex-cli")?.status, "ready");
  assert.equal(findCatalogProbe(probes, "codex-cli", "codex-work")?.status, "failed");
  assert.equal(findCatalogProbe(probes, "codex-cli", "codex-missing"), undefined);

  const cat = {
    models: [],
    skills: [],
    commands: [],
    capabilities: {
      supports_slash: true,
      supports_resume: true,
      supports_questions: true,
      supports_tuning: true,
      supports_skills: true,
      changes: { turn_diff: true, per_file_patch: true, git_scopes: true },
    },
    agent: "codex-cli" as const,
    instance_id: "codex-work",
  } satisfies AgentCatalog;

  assert.equal(matchingInstanceCatalog(cat, "codex-cli", "codex-work"), cat);
  assert.equal(matchingInstanceCatalog(cat, "codex-cli", "codex-cli"), undefined);
  assert.equal(matchingInstanceCatalog(cat, "claude-code", "codex-work"), undefined);
  assert.equal(matchingInstanceCatalog(null, "codex-cli", "codex-work"), undefined);
});
