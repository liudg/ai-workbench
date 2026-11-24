import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { readyAgentCount, sessionAgents } from "@/lib/agents";
import { TOPIC_AGENT_CATALOGS, useTopic } from "@/lib/daemon";
import { profileForSessionAgent } from "@/shared/agent/identity";
import {
  defaultInstanceId,
  effectiveInstanceId,
  type AgentCapabilities,
  type AgentInstallation,
  type AgentInstance,
  type AgentKind,
  type AgentProfile,
  type CatalogProbe,
} from "@/types";
import {
  loadFallbackInstances,
  loadInstallationUpdates,
  loadInstallations,
  loadProfiles,
  refreshInstallations,
  useAgentState,
} from "./agent-store";
import { useAgentUpgrades } from "./use-upgrades";

export interface SelectableInstance {
  instanceId: string;
  kind: AgentKind;
  displayName: string;
  accentColor: string | null;
  isDefault: boolean;
  icon: string | null;
  monochromeIcon: boolean;
  capabilities: AgentCapabilities | undefined;
}

/** 提取每种 AgentKind 的主安装记录（过滤自定义实例派生条目，供设置页主卡片使用）。 */
function baseInstallations(
  installations: readonly AgentInstallation[] | null,
): AgentInstallation[] | null {
  if (installations === null) return null;
  const seen = new Set<AgentKind>();
  const out: AgentInstallation[] = [];
  for (const item of installations) {
    if (
      effectiveInstanceId(item.kind, item.instance_id) === defaultInstanceId(item.kind) &&
      !seen.has(item.kind)
    ) {
      seen.add(item.kind);
      out.push(item);
    }
  }
  for (const item of installations) {
    if (!seen.has(item.kind)) {
      seen.add(item.kind);
      out.push(item);
    }
  }
  return out;
}

/** 组合安装探测、实例配置与 Profile，生成启用且可开会话的实例列表（同种 Agent 的多实例相邻排列）。 */
export function buildSelectableInstances(
  installations: readonly AgentInstallation[] | null,
  instances: readonly AgentInstance[] | null | undefined,
  profiles: Partial<Record<string, AgentProfile>>,
): SelectableInstance[] | null {
  if (installations === null) return null;

  if (instances && instances.length > 0) {
    const kindOrder: AgentKind[] = [];
    const byKind = new Map<AgentKind, AgentInstance[]>();
    for (const inst of instances) {
      let bucket = byKind.get(inst.kind);
      if (!bucket) {
        bucket = [];
        byKind.set(inst.kind, bucket);
        kindOrder.push(inst.kind);
      }
      bucket.push(inst);
    }

    const result: SelectableInstance[] = [];
    for (const kind of kindOrder) {
      const group = byKind.get(kind) ?? [];
      for (const inst of group) {
        if (!inst.enabled) continue;
        const exact = installations.find(
          (item) => effectiveInstanceId(item.kind, item.instance_id) === inst.id,
        );
        const base = !inst.binaryPath
          ? installations.find(
              (item) =>
                item.kind === inst.kind &&
                effectiveInstanceId(item.kind, item.instance_id) === defaultInstanceId(inst.kind),
            )
          : undefined;
        const install = exact ?? base;
        if (!install || !install.installed || !install.session_linked) continue;

        const profile = profileForSessionAgent(inst.kind, profiles, inst.id);
        result.push({
          instanceId: inst.id,
          kind: inst.kind,
          displayName:
            inst.displayName.trim() || profile?.display_name?.trim() || install.display_name,
          accentColor: inst.accentColor?.trim() || profile?.accent_color?.trim() || null,
          isDefault: inst.isDefault || inst.id === defaultInstanceId(inst.kind),
          icon: profile?.icon?.trim() || null,
          monochromeIcon: Boolean(profile?.monochrome_icon),
          capabilities: profile?.capabilities,
        });
      }
    }
    return result;
  }

  const seen = new Set<string>();
  const fallback: SelectableInstance[] = [];
  for (const item of sessionAgents([...installations])) {
    const instanceId = effectiveInstanceId(item.kind, item.instance_id);
    if (seen.has(instanceId)) continue;
    seen.add(instanceId);
    const profile = profileForSessionAgent(item.kind, profiles, instanceId);
    fallback.push({
      instanceId,
      kind: item.kind,
      displayName: profile?.display_name?.trim() || item.display_name,
      accentColor: profile?.accent_color?.trim() || null,
      isDefault: instanceId === defaultInstanceId(item.kind),
      icon: profile?.icon?.trim() || null,
      monochromeIcon: Boolean(profile?.monochrome_icon),
      capabilities: profile?.capabilities,
    });
  }
  return fallback;
}

/** 全部已配置的 Agent 实例（含内置默认实例）。尚未加载完成时为 null。 */
export function useAgentInstances(): AgentInstance[] | null {
  useEffect(loadFallbackInstances, []);
  return useAgentState((state) => state.instances);
}

/** 各 Agent / 实例的能力、斜杠命令、显示名和图标（同时按 instanceId 和默认 AgentKind 索引）。 */
export function useAgentProfiles(): Partial<Record<string, AgentProfile>> {
  useEffect(loadProfiles, []);
  return useAgentState((state) => state.profiles);
}

/** 已启用且本机已安装、可开会话的可选实例列表。还没检测完时为 null。 */
export function useSelectableInstances(): SelectableInstance[] | null {
  useEffect(loadInstallations, []);
  const installations = useAgentState((state) => state.installations);
  const instances = useAgentInstances();
  const profiles = useAgentProfiles();
  return useMemo(
    () => buildSelectableInstances(installations, instances, profiles),
    [installations, instances, profiles],
  );
}

/** 各实例这次启动后探模型目录的结果。还没收到时为 undefined。 */
export function useCatalogProbes(): CatalogProbe[] | undefined {
  return useTopic<CatalogProbe[]>(TOPIC_AGENT_CATALOGS);
}

/** 就绪的 Agent / 实例数。还在检测时为 null。 */
export function useReadyAgentCount(): number | null {
  const selectable = useSelectableInstances();
  const probes = useCatalogProbes();
  const items = useMemo(
    () => selectable?.map((item) => ({ kind: item.kind, instance_id: item.instanceId })) ?? null,
    [selectable],
  );
  return readyAgentCount(items, probes);
}

/** 检测本机 Agent 失败的原因和重试。 */
export function useAgentDetection(): { error: string | null; retry: () => void } {
  const error = useAgentState((state) => state.installationError);
  return { error, retry: () => void refreshInstallations({ preserveUpdates: true }) };
}

/** 设置页：安装列表、检测和升级。 */
export function useAgentInstallations() {
  useEffect(loadInstallationUpdates, []);
  const upgrades = useAgentUpgrades();
  const state = useAgentState(
    useShallow((s) => ({
      installations: s.installations,
      loading: s.installationsLoading,
      error: s.installationError,
    })),
  );
  const base = useMemo(() => baseInstallations(state.installations), [state.installations]);
  return {
    installations: base,
    loading: state.loading,
    error: state.error,
    ...upgrades,
    probes: useCatalogProbes(),
    refresh: () => refreshInstallations({ checkUpdates: true, refreshCatalogs: true }),
  };
}
