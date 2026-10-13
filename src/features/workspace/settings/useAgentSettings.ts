import { useWorkbench } from "@/store";

/** 设置页读安装列表和更新动作。卡片本身不碰 store。 */
export function useAgentSettings() {
  return {
    installations: useWorkbench((s) => s.installations),
    loading: useWorkbench((s) => s.installationsLoading),
    error: useWorkbench((s) => s.installationError),
    updateErrors: useWorkbench((s) => s.updateErrors),
    updatingKind: useWorkbench((s) => s.updatingKind),
    refresh: useWorkbench((s) => s.refreshInstallations),
    updateInstallation: useWorkbench((s) => s.updateInstallation),
    closeSettings: useWorkbench((s) => s.closeSettings),
  };
}
