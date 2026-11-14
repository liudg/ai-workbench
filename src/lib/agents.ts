import type { AgentInstallation, CatalogProbe } from "../types/index.ts";

/**
 * 就绪的 Agent 数：能开会话，并且这次启动后探到了模型目录。
 * 一个都还没就绪、又有还没探完的，返回 null。
 */
export function readyAgentCount(
  agents: AgentInstallation[] | null,
  probes: CatalogProbe[] | undefined,
): number | null {
  if (agents === null) return null;
  const statusOf = (item: AgentInstallation) => probes?.find((probe) => probe.kind === item.kind)?.status;
  const ready = agents.filter((item) => statusOf(item) === "ready").length;
  const pending = agents.some((item) => {
    const status = statusOf(item);
    return status === undefined || status === "probing";
  });
  return ready === 0 && pending ? null : ready;
}

/** 本机探测到已安装的 Agent。探测为空或都未安装时返回空数组，不补种类默认值。 */
export function installedAgents(
  list: AgentInstallation[] | null | undefined,
): AgentInstallation[] {
  if (!list?.length) return [];
  return list.filter((item) => item.installed === true);
}

/**
 * 能开会话的 Agent：已安装，并且会话协议已接入（`session_linked`）。
 * 新会话的 Agent 选择只从这里取。
 */
export function sessionAgents(
  list: AgentInstallation[] | null | undefined,
): AgentInstallation[] {
  return installedAgents(list).filter((item) => item.session_linked === true);
}
