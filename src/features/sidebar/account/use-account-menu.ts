import { useReadyAgentCount } from "@/features/agents";
import { useUpdateCheck } from "@/features/updates";
import { openSettings } from "@/shared/shell/navigation";
import { THEME_OPTIONS, useTheme } from "@/shared/theme";

export function useAccountMenu() {
  const update = useUpdateCheck();
  const readyCount = useReadyAgentCount();
  const theme = useTheme();
  return {
    checkUpdates: update.checkNow,
    checking: update.checking,
    updateBadge: update.badge,
    updateLabel: update.label,
    updateMeta: update.meta,
    openSettings,
    readyCount,
    themePreference: theme.preference,
    themeOptions: THEME_OPTIONS,
    setTheme: theme.setTheme,
  };
}
