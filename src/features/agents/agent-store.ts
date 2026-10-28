// 各 Agent 的能力和本机安装情况。整个应用一份，第一次用到时向 daemon 要。

import { create } from "zustand";

import { userFacingMessage } from "@/lib/user-facing";
import type { AgentInstallation, AgentKind, AgentProfile } from "@/types";
import { agentInstallations, agentProfiles } from "./api";

type Profiles = Partial<Record<AgentKind, AgentProfile>>;

interface AgentState {
  profiles: Profiles;
  /** 还没检测完时为 null。 */
  installations: AgentInstallation[] | null;
  /** 设置页的检测更新正在进行。 */
  installationsLoading: boolean;
  installationError: string | null;
}

const useAgentStore = create<AgentState>()(() => ({
  profiles: {},
  installations: null,
  installationsLoading: false,
  installationError: null,
}));

let profilesRequested = false;
let installationsRequested = false;
let updatesRequested = false;
/** 已经拿到带更新信息的列表。之后到的只看本机的结果不能把它盖掉。 */
let updatesLoaded = false;

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

/** 失败时留着上次的列表（没有就仍为 null），只给出原因。检测失败不等于没装。 */
export async function refreshInstallations(checkUpdates = false) {
  installationsRequested = true;
  if (checkUpdates) {
    updatesRequested = true;
    useAgentStore.setState({ installationsLoading: true, installationError: null });
  }
  try {
    const installations = await agentInstallations(checkUpdates);
    if (checkUpdates) updatesLoaded = true;
    else if (updatesLoaded) return;
    useAgentStore.setState({ installations, installationError: null });
  } catch (error) {
    useAgentStore.setState({ installationError: userFacingMessage(error) });
  } finally {
    if (checkUpdates) useAgentStore.setState({ installationsLoading: false });
  }
}

export function loadInstallations() {
  if (!installationsRequested) void refreshInstallations();
}

/** 设置页：本次运行第一次打开时顺带查一次更新。 */
export function loadInstallationUpdates() {
  if (!updatesRequested) void refreshInstallations(true);
}

/** 开发样例页：直接给出能力和安装情况，不向 daemon 要。 */
export function seedAgents(profiles: Profiles, installations: AgentInstallation[]) {
  profilesRequested = true;
  installationsRequested = true;
  updatesRequested = true;
  useAgentStore.setState({ profiles, installations, installationsLoading: false });
}

export function useAgentState<T>(select: (state: AgentState) => T): T {
  return useAgentStore(select);
}
