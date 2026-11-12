// 应用壳的本机能力：同步原生窗口深浅标题栏外观。

import { getCurrentWindow } from "@tauri-apps/api/window";

import { isTauri } from "@/lib/daemon/endpoint";
import { getResolvedTheme, getThemePreference, subscribeTheme } from "@/shared/theme";

function applyNativeWindowTheme() {
  if (!isTauri) return;
  const preference = getThemePreference();
  const resolved = getResolvedTheme();
  const next = preference === "system" ? null : resolved === "daylight" ? "light" : "dark";
  void getCurrentWindow().setTheme(next).catch(() => {});
}

export function bindNativeWindowTheme(): () => void {
  if (!isTauri) return () => {};
  applyNativeWindowTheme();
  return subscribeTheme(applyNativeWindowTheme);
}
