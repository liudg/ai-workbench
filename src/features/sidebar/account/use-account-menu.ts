import { useSessionAgents } from "@/features/agents";
import { useUpdateCheck } from "@/features/updates";
import { openSettings } from "@/shared/shell/navigation";
import { THEME_OPTIONS, useTheme } from "@/shared/theme";

export function useAccountMenu() {
  const { checking, checkNow } = useUpdateCheck();
  const readyAgents = useSessionAgents();
  const theme = useTheme();
  return {
    checkUpdates: checkNow,
    openSettings,
    checking,
    readyCount: readyAgents === null ? null : readyAgents.length,
    themePreference: theme.preference,
    themeOptions: THEME_OPTIONS,
    setTheme: theme.setTheme,
  };
}
