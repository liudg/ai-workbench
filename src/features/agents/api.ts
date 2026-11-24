// Agent 的 daemon 调用：能力、安装检测、升级、多实例管理、模型目录（上次的和现探的）、新会话的权限菜单。

import { matchingInstanceCatalog } from "@/lib/agents";
import { storedThenProbed } from "@/lib/catalog";
import { CLI_TIMEOUT_MS, daemon, OFFLINE_MESSAGE } from "@/lib/daemon";
import {
  effectiveInstanceId,
  nonDefaultInstanceId,
  type AgentCatalog,
  type AgentEnvVar,
  type AgentInstallation,
  type AgentInstance,
  type AgentKind,
  type AgentProfile,
  type AgentUpgrade,
  type IsolationMode,
  type PermissionMenu,
} from "@/types";

export interface UpsertInstanceInput {
  id?: string;
  kind: AgentKind;
  displayName: string;
  accentColor?: string | null;
  enabled: boolean;
  binaryPath?: string | null;
  launchArgs?: string[];
  environment?: AgentEnvVar[];
  isolationMode: IsolationMode;
  homePath?: string | null;
  sharedHomePath?: string | null;
  sortOrder?: number;
}

export function agentProfiles() {
  return daemon.call<AgentProfile[]>("agents.profiles");
}

/** 本机装了哪些 Agent。`checkUpdates` 时顺带查官方最新版本，要走网络。 */
export function agentInstallations(options: { checkUpdates?: boolean; refreshCatalogs?: boolean }) {
  return daemon.call<AgentInstallation[]>(
    "agents.installations",
    options,
    options.checkUpdates ? CLI_TIMEOUT_MS : undefined,
  );
}

export function upgradeAgent(agent: AgentKind) {
  // 更新只能在连接正常时主动发起，不把安装操作留在离线发送队列里。
  if (daemon.getStatus() !== "online") return Promise.reject(new Error(OFFLINE_MESSAGE));
  return daemon.call<AgentUpgrade>("agents.upgrade", { agent });
}

export function listInstances() {
  return daemon.call<AgentInstance[]>("instances.list");
}

export function upsertInstance(input: UpsertInstanceInput) {
  return daemon.call<AgentInstance>("instances.upsert", { ...input });
}

export function removeInstance(id: string, deleteData = false) {
  return daemon.call<boolean>("instances.remove", { id, deleteData });
}

export function resetDefaultInstance(kind: AgentKind) {
  return daemon.call<AgentInstance>("instances.resetDefault", { kind });
}

const agentCatalogCache = new Map<string, AgentCatalog>();

export function clearCatalogCache(): void {
  agentCatalogCache.clear();
}

export function evictCatalog(agent: AgentKind, instanceId?: string | null): void {
  agentCatalogCache.delete(effectiveInstanceId(agent, instanceId));
}

/** 当前运行期已经拿过的模型目录。按实例隔离，切会话时先用它顶上，避免首帧没有模型。 */
export function peekCatalog(agent: AgentKind, instanceId?: string | null): AgentCatalog | undefined {
  return agentCatalogCache.get(effectiveInstanceId(agent, instanceId));
}

/** 记住实例的模型目录，不跨 Agent 或跨实例混用，也不把单条会话的 `thread_model` 带给别的会话。 */
export function rememberCatalog(
  agent: AgentKind,
  catalog: AgentCatalog,
  overwrite = true,
  instanceId?: string | null,
): void {
  const valid = matchingInstanceCatalog(catalog, agent, instanceId);
  if (!valid || valid.models.length === 0) return;
  const key = effectiveInstanceId(agent, instanceId);
  if (!overwrite && agentCatalogCache.has(key)) return;
  agentCatalogCache.set(key, {
    ...valid,
    thread_model: null,
    thread_effort: null,
  });
}

/** 该实例上一次拿到的模型目录。一次都没拿到过时为 null。 */
export async function cachedCatalog(agent: AgentKind, instanceId?: string | null) {
  const extra = nonDefaultInstanceId(agent, instanceId);
  const catalog = await daemon.call<AgentCatalog | null>(
    "agents.catalog",
    extra ? { agent, instanceId: extra } : { agent },
  );
  const valid = matchingInstanceCatalog(catalog, agent, instanceId);
  if (valid) rememberCatalog(agent, valid, false, instanceId);
  return valid ?? null;
}

/** 这次启动后探成功过就直接给那份；否则在新会话所在的目录里起一次 CLI 探出来，探不到时退回上次的。 */
async function probeCatalog(agent: AgentKind, projectId: string | null, instanceId?: string | null) {
  const extra = nonDefaultInstanceId(agent, instanceId);
  const catalog = await daemon.call<AgentCatalog>(
    "agents.probeCatalog",
    extra ? { agent, projectId, instanceId: extra } : { agent, projectId },
    CLI_TIMEOUT_MS,
  );
  rememberCatalog(agent, catalog, true, instanceId);
  return catalog;
}

/** 存下的目录先给，现探的新目录到了再给一次。两样都没有时 reject。 */
export function loadCatalog(
  agent: AgentKind,
  projectId: string | null,
  show: (catalog: AgentCatalog) => void,
  instanceId?: string | null,
) {
  return storedThenProbed(
    cachedCatalog(agent, instanceId),
    probeCatalog(agent, projectId, instanceId),
    show,
  );
}

export function draftPermissionMenu(agent: AgentKind, instanceId?: string | null) {
  const extra = nonDefaultInstanceId(agent, instanceId);
  return daemon.call<PermissionMenu>(
    "agents.permissionMenu",
    extra ? { agent, instanceId: extra } : { agent },
  );
}
