import type { AgentInstallation, AgentKind } from "@/types";

/** 新建会话可选的 Agent：只保留本机已经探测到的安装。 */
export function installedAgents(
  list: AgentInstallation[] | null | undefined,
): AgentInstallation[] {
  return (list ?? []).filter((item) => item.installed);
}

/**
 * 写进项目记录的默认 Agent。优先用已安装且用户最近选过的；
 * 都没装时才退回探测名单的第一项，界面不会把它列进选择器。
 */
export function persistedAgentKind(
  list: AgentInstallation[] | null | undefined,
  preferred: AgentKind | null,
): AgentKind | null {
  const installed = installedAgents(list);
  if (preferred && installed.some((item) => item.kind === preferred)) {
    return preferred;
  }
  if (installed.length > 0) return installed[0].kind;
  return list?.[0]?.kind ?? null;
}

export function keepPreferredAgent(
  current: AgentKind | null,
  list: AgentInstallation[],
): AgentKind | null {
  const installed = installedAgents(list);
  if (current && installed.some((item) => item.kind === current)) return current;
  if (installed.length === 1) return installed[0].kind;
  return null;
}
