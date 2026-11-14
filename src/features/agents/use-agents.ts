import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { readyAgentCount, sessionAgents } from "@/lib/agents";
import { TOPIC_AGENT_CATALOGS, useTopic } from "@/lib/daemon";
import type { AgentInstallation, AgentKind, AgentProfile, CatalogProbe } from "@/types";
import {
  loadInstallationUpdates,
  loadInstallations,
  loadProfiles,
  refreshInstallations,
  useAgentState,
} from "./agent-store";
import { useAgentUpgrades } from "./use-upgrades";

/** 各 Agent 的能力、斜杠命令、显示名和图标。 */
export function useAgentProfiles(): Partial<Record<AgentKind, AgentProfile>> {
  useEffect(loadProfiles, []);
  return useAgentState((state) => state.profiles);
}

/** 能开会话的 Agent。还没检测完时为 null。 */
export function useSessionAgents(): AgentInstallation[] | null {
  useEffect(loadInstallations, []);
  const installations = useAgentState((state) => state.installations);
  return installations === null ? null : sessionAgents(installations);
}

/** 各 Agent 这次启动后探模型目录的结果。还没收到时为 undefined。 */
function useCatalogProbes(): CatalogProbe[] | undefined {
  return useTopic<CatalogProbe[]>(TOPIC_AGENT_CATALOGS);
}

/** 就绪的 Agent 数。还在检测时为 null。 */
export function useReadyAgentCount(): number | null {
  return readyAgentCount(useSessionAgents(), useCatalogProbes());
}

/** 检测本机 Agent 失败的原因和重试。 */
export function useAgentDetection(): { error: string | null; retry: () => void } {
  const error = useAgentState((state) => state.installationError);
  return { error, retry: () => void refreshInstallations() };
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
  return { ...state, ...upgrades, probes: useCatalogProbes(), refresh: () => refreshInstallations(true) };
}
