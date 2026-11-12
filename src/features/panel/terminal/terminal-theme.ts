import type { ITheme } from "@xterm/xterm";

import type { ResolvedTheme } from "../../../shared/theme/index.ts";

const OBSIDIAN_PALETTE: ITheme = {
  background: "#0d0f13",
  foreground: "#ededf0",
  cursor: "#ededf0",
  cursorAccent: "#0d0f13",
  selectionBackground: "rgba(94, 129, 255, 0.34)",
  selectionInactiveBackground: "rgba(94, 129, 255, 0.18)",
  black: "#1f232c",
  red: "#f06868",
  green: "#46c483",
  yellow: "#e8a44a",
  blue: "#6b8cff",
  magenta: "#c792ea",
  cyan: "#4ec9b0",
  white: "#d5d9e2",
  brightBlack: "#6e7687",
  brightRed: "#ff8585",
  brightGreen: "#6ee7b7",
  brightYellow: "#f6c177",
  brightBlue: "#8da8ff",
  brightMagenta: "#ddb6f2",
  brightCyan: "#7de2cf",
  brightWhite: "#f4f5f8",
};

const DAYLIGHT_PALETTE: ITheme = {
  background: "#f7f8fa",
  foreground: "#14171f",
  cursor: "#14171f",
  cursorAccent: "#f7f8fa",
  selectionBackground: "rgba(59, 91, 219, 0.22)",
  selectionInactiveBackground: "rgba(59, 91, 219, 0.12)",
  black: "#1e2330",
  red: "#c92a2a",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#2b4acb",
  magenta: "#7e22ce",
  cyan: "#0f766e",
  white: "#4b5565",
  brightBlack: "#647084",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#b45309",
  brightBlue: "#3b5bdb",
  brightMagenta: "#9333ea",
  brightCyan: "#0d9488",
  brightWhite: "#14171f",
};

function nonTransparentColor(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "transparent") return null;
  if (/^(?:rgba|hsla)\([^)]*[,\s/]\s*0(?:\.0+)?%?\s*\)$/i.test(trimmed)) return null;
  if (/^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/i.test(trimmed)) return null;
  return trimmed;
}

export function terminalThemeFor(
  resolved: ResolvedTheme,
  hostBackground?: string,
  hostForeground?: string,
): ITheme {
  const base = resolved === "daylight" ? DAYLIGHT_PALETTE : OBSIDIAN_PALETTE;
  const background = nonTransparentColor(hostBackground) ?? base.background;
  const foreground = nonTransparentColor(hostForeground) ?? base.foreground;
  return {
    ...base,
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
  };
}
