// Agent 的 daemon 调用：能力、安装检测、升级、上次的模型目录、新会话的权限菜单。

import { daemon } from "@/lib/daemon";
import type { AgentCatalog, AgentInstallation, AgentKind, AgentProfile, PermissionMenu } from "@/types";

export function agentProfiles() {
  return daemon.call<AgentProfile[]>("agents.profiles");
}

export function agentInstallations() {
  return daemon.call<AgentInstallation[]>("agents.installations");
}

export function upgradeAgent(agent: AgentKind) {
  return daemon.call<AgentInstallation>("agents.upgrade", { agent });
}

/** 这种 Agent 上一次拿到的模型目录。一次都没拿到过时为 null。 */
export function cachedCatalog(agent: AgentKind) {
  return daemon.call<AgentCatalog | null>("agents.catalog", { agent });
}

export function draftPermissionMenu(agent: AgentKind) {
  return daemon.call<PermissionMenu>("agents.permissionMenu", { agent });
}
