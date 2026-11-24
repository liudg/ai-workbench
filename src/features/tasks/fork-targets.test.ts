import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentCapabilities, AgentProfile } from "../../types/index.ts";
import { forkTargets } from "./fork-targets.ts";

const handoffCaps: AgentCapabilities = {
  supports_slash: true,
  supports_resume: true,
  supports_questions: true,
  supports_tuning: true,
  supports_skills: true,
  supports_fork: true,
  supports_context_handoff: true,
  changes: { turn_diff: true, per_file_patch: true, git_scopes: true },
};

function profile(kind: "codex-cli" | "claude-code", instanceId: string, name: string): AgentProfile {
  return {
    kind,
    instance_id: instanceId,
    display_name: name,
    icon: "",
    capabilities: handoffCaps,
    commands: [],
  };
}

test("forkTargets keeps explicit instanceId for default instance when forking from a custom instance", () => {
  const profiles: Partial<Record<string, AgentProfile>> = {
    "codex-cli": profile("codex-cli", "codex-cli", "Codex 默认"),
    "codex-work": profile("codex-cli", "codex-work", "Codex 工作号"),
    "claude-code": profile("claude-code", "claude-code", "Claude Code"),
  };

  const targets = forkTargets(
    {
      agent: "codex-cli",
      instanceId: "codex-work",
      status: "completed",
      nativeId: "native-1",
    },
    profiles,
    [
      { kind: "codex-cli", instanceId: "codex-cli", displayName: "Codex 默认" },
      { kind: "codex-cli", instanceId: "codex-work", displayName: "Codex 工作号" },
      { kind: "claude-code", instanceId: "claude-code", displayName: "Claude Code" },
    ],
  );

  assert.deepEqual(targets, [
    { agent: "codex-cli", instanceId: "codex-work", name: "Codex 工作号", same: true },
    { agent: "codex-cli", instanceId: "codex-cli", name: "Codex 默认", same: false },
    { agent: "claude-code", instanceId: "claude-code", name: "Claude Code", same: false },
  ]);
});
