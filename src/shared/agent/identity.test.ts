import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentKind, AgentProfile } from "../../types/index.ts";
import { agentIdentity, profileForSessionAgent } from "./identity.ts";

function profile(kind: AgentKind, name: string, icon: string | null): AgentProfile {
  return {
    kind,
    display_name: name,
    icon,
    commands: [],
    capabilities: {
      supports_slash: false,
      supports_resume: false,
      supports_questions: false,
      supports_tuning: false,
      supports_skills: false,
      changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
    },
  };
}

test("identity comes only from that agent's profile", () => {
  const profiles = {
    "claude-code": profile("claude-code", "Claude Code", "/agent-icons/claude.svg"),
    "cursor-agent": profile("cursor-agent", "Cursor Agent", null),
  };
  assert.equal(profileForSessionAgent("codex-cli", profiles), undefined);
  assert.equal(agentIdentity("codex-cli", profiles["claude-code"]), null);
  assert.deepEqual(agentIdentity("claude-code", profiles["claude-code"]), {
    name: "Claude Code",
    icon: "/agent-icons/claude.svg",
  });
  assert.deepEqual(agentIdentity("cursor-agent", profiles["cursor-agent"]), {
    name: "Cursor Agent",
    icon: null,
  });
});

test("a profile stored under the wrong agent is ignored", () => {
  const misplaced = {
    "codex-cli": profile("claude-code", "Claude Code", "/agent-icons/claude.svg"),
  } as Partial<Record<AgentKind, AgentProfile>>;
  assert.equal(profileForSessionAgent("codex-cli", misplaced), undefined);
  assert.equal(agentIdentity("codex-cli", misplaced["codex-cli"]), null);
});

test("blank adapter identity does not invent a name or icon", () => {
  const blank = profile("codex-cli", "  ", "  ");
  assert.equal(agentIdentity("codex-cli", blank), null);
  assert.equal(agentIdentity("codex-cli", undefined), null);
});
