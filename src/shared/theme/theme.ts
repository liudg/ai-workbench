import { useSyncExternalStore } from "react";

export type ThemePreference = "obsidian" | "daylight" | "system";
export type ResolvedTheme = "obsidian" | "daylight";

interface ThemeOption {
  id: ThemePreference;
  label: string;
  hint: string;
}

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: "daylight", label: "浅色", hint: "明亮清晰的浅色界面" },
  { id: "obsidian", label: "深色", hint: "低眩光深色界面" },
  { id: "system", label: "跟随系统", hint: "随系统深浅外观自动切换" },
];

const STORAGE_KEY = "aiwb.theme";
const LIGHT_MEDIA = "(prefers-color-scheme: light)";

export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  if (raw === "obsidian" || raw === "daylight" || raw === "system") return raw;
  return "obsidian";
}

export function resolveTheme(preference: ThemePreference, systemPrefersLight: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersLight ? "daylight" : "obsidian";
  return preference;
}

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "obsidian";
  try {
    return parseThemePreference(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return "obsidian";
  }
}

function writeStoredPreference(preference: ThemePreference) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // 无痕或受限环境下只保留内存态。
  }
}

function readSystemLight(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(LIGHT_MEDIA).matches;
}

let currentPreference: ThemePreference = readStoredPreference();
let currentResolved: ResolvedTheme = resolveTheme(currentPreference, readSystemLight());
let mediaBound = false;
const listeners = new Set<() => void>();

function applyDomTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle("dark", resolved === "obsidian");
  root.style.colorScheme = resolved === "daylight" ? "light" : "dark";
}

function emit() {
  for (const listener of listeners) listener();
}

function syncResolved() {
  const next = resolveTheme(currentPreference, readSystemLight());
  applyDomTheme(next);
  if (next === currentResolved) return;
  currentResolved = next;
  emit();
}

function ensureMediaListener() {
  if (mediaBound || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  mediaBound = true;
  const media = window.matchMedia(LIGHT_MEDIA);
  media.addEventListener?.("change", syncResolved);
}

/** 启动时同步写入根节点主题，避免首屏闪烁。 */
export function initTheme(): ResolvedTheme {
  currentPreference = readStoredPreference();
  currentResolved = resolveTheme(currentPreference, readSystemLight());
  applyDomTheme(currentResolved);
  ensureMediaListener();
  return currentResolved;
}

export function getThemePreference(): ThemePreference {
  return currentPreference;
}

export function getResolvedTheme(): ResolvedTheme {
  return currentResolved;
}

export function setThemePreference(next: ThemePreference) {
  ensureMediaListener();
  const prevPref = currentPreference;
  const prevResolved = currentResolved;
  currentPreference = next;
  currentResolved = resolveTheme(next, readSystemLight());
  writeStoredPreference(next);
  applyDomTheme(currentResolved);
  if (prevPref !== currentPreference || prevResolved !== currentResolved) emit();
}

/** 在深色与浅色之间一键切换。 */
export function toggleTheme(): ResolvedTheme {
  const next: ResolvedTheme = currentResolved === "obsidian" ? "daylight" : "obsidian";
  setThemePreference(next);
  return next;
}

export function subscribeTheme(listener: () => void): () => void {
  ensureMediaListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

interface ThemeSnapshot {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

let cachedSnapshot: ThemeSnapshot = {
  preference: currentPreference,
  resolved: currentResolved,
};

function getSnapshot(): ThemeSnapshot {
  if (cachedSnapshot.preference !== currentPreference || cachedSnapshot.resolved !== currentResolved) {
    cachedSnapshot = { preference: currentPreference, resolved: currentResolved };
  }
  return cachedSnapshot;
}

export function useTheme() {
  const { preference, resolved } = useSyncExternalStore(subscribeTheme, getSnapshot, getSnapshot);
  return {
    preference,
    resolved,
    setTheme: setThemePreference,
    toggleTheme,
  };
}
