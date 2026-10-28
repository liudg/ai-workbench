// Agent 的 daemon 调用：能力、安装检测、升级、模型目录（上次的或现探的）、新会话的权限菜单。

import { CLI_TIMEOUT_MS, daemon } from "@/lib/daemon";
import type { AgentCatalog, AgentInstallation, AgentKind, AgentProfile, PermissionMenu } from "@/types";

export function agentProfiles() {
  return daemon.call<AgentProfile[]>("agents.profiles");
}

/** 本机装了哪些 Agent。`checkUpdates` 时顺带查官方最新版本，要走网络。 */
export function agentInstallations(checkUpdates: boolean) {
  return daemon.call<AgentInstallation[]>(
    "agents.installations",
    { checkUpdates },
    checkUpdates ? CLI_TIMEOUT_MS : undefined,
  );
}

export function upgradeAgent(agent: AgentKind) {
  return daemon.call<AgentInstallation>("agents.upgrade", { agent });
}

/** 这种 Agent 上一次拿到的模型目录。一次都没拿到过时为 null。 */
export function cachedCatalog(agent: AgentKind) {
  return daemon.call<AgentCatalog | null>("agents.catalog", { agent });
}

/** 这次启动后还没拿到过新目录时，在新会话所在的目录里起一次 CLI 探出来。探不到时退回上次的。 */
export function probeCatalog(agent: AgentKind, projectId: string | null) {
  return daemon.call<AgentCatalog>("agents.probeCatalog", { agent, projectId }, CLI_TIMEOUT_MS);
}

export function draftPermissionMenu(agent: AgentKind) {
  return daemon.call<PermissionMenu>("agents.permissionMenu", { agent });
}
