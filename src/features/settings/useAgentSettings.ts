import { useAgentInstallations } from "@/features/agents";
import { closeSettings } from "@/shared/shell/navigation";

/** 设置页读安装列表和更新动作。卡片本身不碰数据来源。 */
export function useAgentSettings() {
  const agents = useAgentInstallations();
  return {
    installations: agents.installations,
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
