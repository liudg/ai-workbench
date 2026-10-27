import type { AgentInstallation } from "../types/index.ts";

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
