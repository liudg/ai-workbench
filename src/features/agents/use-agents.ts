import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { sessionAgents } from "@/lib/agents";
import type { AgentInstallation, AgentKind, AgentProfile } from "@/types";
import {
  loadInstallations,
  loadProfiles,
  refreshInstallations,
  upgradeInstallation,
  useAgentState,
} from "./agent-store";

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

/** 设置页：安装列表、检测和升级。 */
export function useAgentInstallations() {
  useEffect(loadInstallations, []);
  const state = useAgentState(
    useShallow((s) => ({
      installations: s.installations,
      loading: s.installationsLoading,
      error: s.installationError,
      upgradeErrors: s.upgradeErrors,
      upgrading: s.upgrading,
    })),
  );
  return { ...state, refresh: refreshInstallations, upgrade: upgradeInstallation };
}
