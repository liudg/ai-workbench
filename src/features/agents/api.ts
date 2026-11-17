// Agent 的 daemon 调用：能力、安装检测、升级、模型目录（上次的和现探的）、新会话的权限菜单。

import { storedThenProbed } from "@/lib/catalog";
import { CLI_TIMEOUT_MS, daemon, OFFLINE_MESSAGE } from "@/lib/daemon";
import type { AgentCatalog, AgentInstallation, AgentKind, AgentProfile, AgentUpgrade, PermissionMenu } from "@/types";

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
  // 更新只能在连接正常时主动发起，不把安装操作留在离线发送队列里。
  if (daemon.getStatus() !== "online") return Promise.reject(new Error(OFFLINE_MESSAGE));
  return daemon.call<AgentUpgrade>("agents.upgrade", { agent });
}

const agentCatalogCache = new Map<AgentKind, AgentCatalog>();

/** 当前运行期已经拿过的模型目录。切会话时先用它顶上，避免首帧没有模型。 */
export function peekCatalog(agent: AgentKind): AgentCatalog | undefined {
  return agentCatalogCache.get(agent);
}

/** 记住 Agent 的公共模型目录，不跨 Agent 混用，也不把单条会话的 `thread_model` 带给别的会话。 */
export function rememberCatalog(agent: AgentKind, catalog: AgentCatalog, overwrite = true): void {
  if (catalog.models.length === 0 || (catalog.agent && catalog.agent !== agent)) return;
  if (!overwrite && agentCatalogCache.has(agent)) return;
  agentCatalogCache.set(agent, {
    ...catalog,
    thread_model: null,
    thread_effort: null,
  });
}

/** 这种 Agent 上一次拿到的模型目录。一次都没拿到过时为 null。 */
export async function cachedCatalog(agent: AgentKind) {
  const catalog = await daemon.call<AgentCatalog | null>("agents.catalog", { agent });
  if (catalog) rememberCatalog(agent, catalog, false);
  return catalog;
}

/** 这次启动后探成功过就直接给那份；否则在新会话所在的目录里起一次 CLI 探出来，探不到时退回上次的。 */
async function probeCatalog(agent: AgentKind, projectId: string | null) {
  const catalog = await daemon.call<AgentCatalog>("agents.probeCatalog", { agent, projectId }, CLI_TIMEOUT_MS);
  rememberCatalog(agent, catalog, true);
  return catalog;
}

/** 存下的目录先给，现探的新目录到了再给一次。两样都没有时 reject。 */
export function loadCatalog(agent: AgentKind, projectId: string | null, show: (catalog: AgentCatalog) => void) {
  return storedThenProbed(cachedCatalog(agent), probeCatalog(agent, projectId), show);
}

export function draftPermissionMenu(agent: AgentKind) {
  return daemon.call<PermissionMenu>("agents.permissionMenu", { agent });
}
