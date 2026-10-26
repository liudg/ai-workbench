// 各 Agent 的能力和本机安装情况。整个应用一份，第一次用到时向 daemon 要。

import { create } from "zustand";

import { userFacingMessage } from "@/lib/user-facing";
import type { AgentInstallation, AgentKind, AgentProfile } from "@/types";
import { agentInstallations, agentProfiles, upgradeAgent } from "./api";

type Profiles = Partial<Record<AgentKind, AgentProfile>>;

interface AgentState {
  profiles: Profiles;
  /** 还没检测完时为 null。 */
  installations: AgentInstallation[] | null;
  installationsLoading: boolean;
  installationError: string | null;
  /** 某张卡片上的升级失败。和顶部的 `installationError` 分开。 */
  upgradeErrors: Partial<Record<AgentKind, string>>;
  upgrading: AgentKind | null;
}

const useAgentStore = create<AgentState>()(() => ({
  profiles: {},
  installations: null,
  installationsLoading: false,
  installationError: null,
  upgradeErrors: {},
  upgrading: null,
}));

let profilesRequested = false;
let installationsRequested = false;

export function loadProfiles() {
  if (profilesRequested) return;
  profilesRequested = true;
  agentProfiles().then(
    (list) => useAgentStore.setState({ profiles: Object.fromEntries(list.map((item) => [item.kind, item])) }),
    () => {
      profilesRequested = false;
    },
  );
}

export async function refreshInstallations() {
  installationsRequested = true;
  useAgentStore.setState({ installationsLoading: true });
  try {
    const installations = await agentInstallations();
    useAgentStore.setState({ installations, installationsLoading: false, installationError: null });
  } catch (error) {
    useAgentStore.setState((state) => ({
      installationsLoading: false,
      installationError: userFacingMessage(error),
      installations: state.installations ?? [],
    }));
  }
}

export function loadInstallations() {
  if (!installationsRequested) void refreshInstallations();
}

export async function upgradeInstallation(kind: AgentKind) {
  useAgentStore.setState((state) => {
    const upgradeErrors = { ...state.upgradeErrors };
    delete upgradeErrors[kind];
    return { upgrading: kind, installationError: null, upgradeErrors };
  });
  try {
    const next = await upgradeAgent(kind);
    useAgentStore.setState((state) => ({
      upgrading: null,
      installations: (state.installations ?? []).map((item) => (item.kind === kind ? next : item)),
    }));
  } catch (error) {
    const message = userFacingMessage(error) ?? "更新失败";
    useAgentStore.setState((state) => ({
      upgrading: null,
      installationError: message,
      upgradeErrors: { ...state.upgradeErrors, [kind]: message },
    }));
  }
}

export function useAgentState<T>(select: (state: AgentState) => T): T {
  return useAgentStore(select);
}
