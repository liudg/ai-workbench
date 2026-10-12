import type { AgentInstallation, AgentKind } from "../types.ts";

/** 本机探测到已安装的 Agent。探测为空或都未安装时返回空数组，不补种类默认值。 */
export function installedAgents(
  list: AgentInstallation[] | null | undefined,
): AgentInstallation[] {
  if (!list?.length) return [];
  return list.filter((item) => item.installed === true);
}

/**
 * 能开会话的 Agent：已安装，并且会话协议已接入（`session_linked`）。
 * 新建会话、项目默认 Agent 都只从这里取。
 */
export function sessionAgents(
  list: AgentInstallation[] | null | undefined,
): AgentInstallation[] {
  return installedAgents(list).filter((item) => item.session_linked === true);
}

/** 已安装但会话协议未接入的 Agent。新建会话菜单只把它们列成不可选。 */
export function unlinkedAgents(
  list: AgentInstallation[] | null | undefined,
): AgentInstallation[] {
  return installedAgents(list).filter((item) => item.session_linked !== true);
}

/**
 * 写进项目记录的默认 Agent。只用能开会话、且用户最近选过的；
 * 否则用第一个能开会话的。一个都没有时返回 null，不拿注册表第一项充数。
 */
export function persistedAgentKind(
  list: AgentInstallation[] | null | undefined,
  preferred: AgentKind | null,
): AgentKind | null {
  const usable = sessionAgents(list);
  if (preferred && usable.some((item) => item.kind === preferred)) {
    return preferred;
  }
  return usable[0]?.kind ?? null;
}

export function keepPreferredAgent(
  current: AgentKind | null,
  list: AgentInstallation[],
): AgentKind | null {
  const usable = sessionAgents(list);
  if (current && usable.some((item) => item.kind === current)) return current;
  if (usable.length === 1) return usable[0].kind;
  return null;
}
