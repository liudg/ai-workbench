import { useAgentInstallations, useAgentInstances, useAgentProfiles } from "@/features/agents";
import { closeSettings } from "@/shared/shell/navigation";

/** 设置页读安装列表、多实例配置、适配器能力与更新动作。卡片本身不碰数据来源。 */
export function useAgentSettings() {
  const agents = useAgentInstallations();
  const profiles = useAgentProfiles();
  const instances = useAgentInstances();
  return {
    installations: agents.installations,
    probes: agents.probes,
    profiles,
    instances,
    loading: agents.loading,
    error: agents.error,
    updateErrors: agents.upgradeErrors,
    upgrades: agents.upgrades,
    starting: agents.starting,
    upgradesReady: agents.upgradesReady,
    refresh: agents.refresh,
    updateInstallation: agents.upgrade,
    closeSettings,
  };
}
