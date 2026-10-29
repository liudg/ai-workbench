import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentInstallation } from "@/types";
import { agentCardFace, statusLabel } from "./agent-card.ts";

function item(patch: Partial<AgentInstallation>): AgentInstallation {
  return {
    kind: "kimi-code",
    display_name: "Kimi Code",
    installed: false,
    version: null,
    latest_version: null,
    update_available: false,
    update_via: null,
    detail: "会话协议尚未接入，目前仅支持检测和更新。工作空间代为安装。",
    session_linked: false,
    ...patch,
  };
}

test("an unwired agent that is missing says 未安装 · 未接入", () => {
  const face = agentCardFace(item({ installed: false, update_available: true }));
  assert.equal(face.kind, "unwired");
  if (face.kind !== "unwired") return;
  assert.equal(face.lead, "未安装");
  assert.equal(face.canUpdate, false);
  assert.equal(statusLabel(face), "未安装 · 未接入");
});

test("an installed unwired agent puts the version and 未接入 on one line", () => {
  const face = agentCardFace(
    item({
      kind: "cursor-agent",
      display_name: "Cursor Agent",
      installed: true,
      version: "2026.10.01",
      latest_version: "2026.10.08",
      update_available: true,
      update_via: "cli",
      session_linked: false,
    }),
  );
  assert.equal(face.kind, "unwired");
  if (face.kind !== "unwired") return;
  assert.equal(face.lead, "2026.10.01");
  assert.equal(face.canUpdate, true);
  assert.equal(statusLabel(face), "2026.10.01 · 未接入");

  const current = agentCardFace(
    item({
      kind: "cursor-agent",
      display_name: "Cursor Agent",
      installed: true,
      version: "2026.10.09",
      latest_version: "2026.10.09",
      update_available: false,
      update_via: "cli",
      session_linked: false,
    }),
  );
  assert.equal(current.kind, "unwired");
  if (current.kind !== "unwired") return;
  assert.equal(current.canUpdate, false);
  assert.equal(current.lead, "2026.10.09");
  assert.equal(statusLabel(current), "2026.10.09 · 未接入");
});

test("an unwired agent that can still update does not say it is current", () => {
  const face = agentCardFace(
    item({
      kind: "cursor-agent",
      display_name: "Cursor Agent",
      installed: true,
      version: "2026.10.01-e373342",
      latest_version: null,
      update_available: true,
      update_via: "cli",
      session_linked: false,
    }),
  );
  assert.equal(face.kind, "unwired");
  if (face.kind !== "unwired") return;
  assert.equal(face.canUpdate, true);
  assert.equal(statusLabel(face), "2026.10.01-e373342 · 未接入");
});

test("an installed linked agent keeps version, latest, and the update action", () => {
  const current = agentCardFace(
    item({
      kind: "codex-cli",
      display_name: "Codex CLI",
      installed: true,
      version: "0.162.0",
      latest_version: "0.162.0",
      update_available: false,
      session_linked: true,
      detail: null,
    }),
  );
  assert.equal(current.kind, "ready");
  if (current.kind !== "ready") return;
  assert.equal(current.text, "0.162.0");
  assert.equal(current.canUpdate, false);
  assert.equal(statusLabel(current), "0.162.0");

  const pending = agentCardFace(
    item({
      kind: "claude-code",
      display_name: "Claude Code",
      installed: true,
      version: "2.1.200",
      latest_version: "2.1.292",
      update_available: true,
      update_via: "cli",
      session_linked: true,
      detail: "暂时无法查询官方最新版本。",
    }),
  );
  assert.equal(pending.kind, "ready");
  if (pending.kind !== "ready") return;
  assert.equal(pending.text, "2.1.200 · 可更新到 2.1.292 · 官方 CLI");
  assert.equal(pending.canUpdate, true);
  assert.equal(pending.detail, "暂时无法查询官方最新版本。");
});

test("a linked agent that is not installed still says 未安装", () => {
  const face = agentCardFace(
    item({
      kind: "codex-cli",
      display_name: "Codex CLI",
      installed: false,
      session_linked: true,
      detail: null,
    }),
  );
  assert.equal(face.kind, "absent");
  assert.equal(statusLabel(face), "未安装");
});
