import type { AgentInstallation, UpdateVia } from "@/types";

/** 设置卡片在状态行上的样子。未接入时前缀和「未接入」写在同一行。 */
export type AgentCardFace =
  | { kind: "absent" }
  | { kind: "unwired"; lead: string }
  | { kind: "ready"; text: string; canUpdate: boolean; detail: string | null };

function viaLabel(via: UpdateVia | null): string | null {
  if (via === "npm") return "npm";
  if (via === "cli") return "官方 CLI";
  return null;
}

function readyText(item: AgentInstallation): string {
  const version = item.version ?? "已安装";
  if (item.update_available && item.latest_version) {
    const via = viaLabel(item.update_via);
    return via
      ? `${version} · 可更新到 ${item.latest_version} · ${via}`
      : `${version} · 可更新到 ${item.latest_version}`;
  }
  if (item.latest_version && item.version === item.latest_version) {
    return `${version} · 已是最新`;
  }
  return version;
}

/**
 * 协议未接入时，状态行只有「未安装 · 未接入」或「版本 · 未接入」。
 * 已接入才保留版本、最新和更新按钮。不看 Agent 种类。
 */
export function agentCardFace(item: AgentInstallation): AgentCardFace {
  if (!item.session_linked) {
    return { kind: "unwired", lead: item.installed ? (item.version ?? "已安装") : "未安装" };
  }
  if (!item.installed) return { kind: "absent" };
  return {
    kind: "ready",
    text: readyText(item),
    canUpdate: item.update_available,
    detail: item.detail,
  };
}

export function statusLabel(face: AgentCardFace): string {
  if (face.kind === "absent") return "未安装";
  if (face.kind === "unwired") return `${face.lead} · 未接入`;
  return face.text;
}
