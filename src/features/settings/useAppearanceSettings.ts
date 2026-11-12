import { THEME_OPTIONS, useTheme, type ThemePreference } from "@/shared/theme";

export type { ThemePreference };

export function useAppearanceSettings() {
  const { preference, setTheme } = useTheme();
  return {
    options: THEME_OPTIONS,
    preference,
    setTheme,
  };
}
