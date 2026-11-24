import {
  effectiveInstanceId,
  type AgentCatalog,
  type AgentInstallation,
  type AgentKind,
  type CatalogProbe,
} from "../types/index.ts";

/** 按 `(kind, effectiveInstanceId)` 查找对应实例的模型目录探测状态。 */
export function findCatalogProbe(
  probes: readonly CatalogProbe[] | undefined,
  kind: AgentKind,
  instanceId?: string | null,
): CatalogProbe | undefined {
  if (!probes) return undefined;
  const targetId = effectiveInstanceId(kind, instanceId);
  return probes.find(
    (probe) => probe.kind === kind && effectiveInstanceId(probe.kind, probe.instance_id) === targetId,
  );
}

/** 校验目录归属与目标 `(agent, instanceId)` 一致，防止跨种类或跨实例串用模型目录。 */
export function matchingInstanceCatalog(
  catalog: AgentCatalog | null | undefined,
  agent: AgentKind,
  instanceId?: string | null,
): AgentCatalog | undefined {
  if (!catalog || (catalog.agent && catalog.agent !== agent)) return undefined;
  const expected = effectiveInstanceId(agent, instanceId);
  if (catalog.instance_id && effectiveInstanceId(agent, catalog.instance_id) !== expected) {
    return undefined;
  }
  return catalog;
}

/**
 * 就绪的 Agent / 实例数：能开会话，并且这次启动后探到了对应实例的模型目录。
 * 一个都还没就绪、又有还没探完的，返回 null。
 */
export function readyAgentCount(
  agents: readonly Pick<AgentInstallation, "kind" | "instance_id">[] | null,
  probes: readonly CatalogProbe[] | undefined,
): number | null {
  if (agents === null) return null;
  const statusOf = (item: Pick<AgentInstallation, "kind" | "instance_id">) =>
    findCatalogProbe(probes, item.kind, item.instance_id)?.status;
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
