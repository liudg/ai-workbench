import type { AgentInstallation, UpdateVia } from "@/types";

/** 设置卡片在状态行上的样子。未接入时前缀和「未接入」写在同一行。 */
export type AgentCardFace =
  | { kind: "absent" }
  | { kind: "unwired"; lead: string; canUpdate: boolean }
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
  return version;
}

/**
 * 协议未接入时，状态行是「未安装 · 未接入」或「版本 · 未接入」。
 * 已经装上、并且官方更新还可用时，未接入的卡片也保留「更新」。
 * 官方确认当前版本后只收起按钮，状态行不再另写说明。
 */
export function agentCardFace(item: AgentInstallation): AgentCardFace {
  if (!item.session_linked) {
    return {
      kind: "unwired",
      lead: item.installed ? (item.version ?? "已安装") : "未安装",
      canUpdate: item.installed && item.update_available,
    };
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
