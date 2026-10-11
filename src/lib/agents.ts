import type { AgentInstallation, AgentKind } from "../types.ts";

/**
 * 新建会话可选的 Agent。与设置页「本地 Agent」同一份探测结果，
 * 只保留 `installed === true`。探测为空或都未安装时返回空数组，不补种类默认值。
 */
export function installedAgents(
  list: AgentInstallation[] | null | undefined,
): AgentInstallation[] {
  if (!list?.length) return [];
  return list.filter((item) => item.installed === true);
}

/**
 * 写进项目记录的默认 Agent。只用已安装、且用户最近选过的；
 * 否则用探测结果里第一个已安装项。一个都没装时返回 null，不拿注册表第一项充数。
 */
export function persistedAgentKind(
  list: AgentInstallation[] | null | undefined,
  preferred: AgentKind | null,
): AgentKind | null {
  const installed = installedAgents(list);
  if (preferred && installed.some((item) => item.kind === preferred)) {
    return preferred;
  }
  return installed[0]?.kind ?? null;
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
