import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

export type WorkbenchTheme = "graphite" | "daylight";
export type ThemePreference = WorkbenchTheme | "system";

export const THEME_STORAGE_KEY = "wb.theme.preference" as const;

export interface ThemeOption {
  id: ThemePreference;
  label: string;
}

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: "graphite", label: "冷冽钛灰" },
  { id: "daylight", label: "雾银纸白" },
  { id: "system", label: "跟随系统" },
] as const;

export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  if (raw === "graphite" || raw === "daylight" || raw === "system") {
    return raw;
  }
  return "graphite";
}

export function parseThemeOverrideFromSearch(search: string | null | undefined): WorkbenchTheme | null {
  if (!search) return null;
  try {
    const raw = new URLSearchParams(search).get("theme");
    if (raw === "graphite" || raw === "daylight") return raw;
  } catch {
    return null;
  }
  return null;
}

export function resolveWorkbenchTheme(
  preference: ThemePreference,
  systemPrefersLight: boolean,
  override: WorkbenchTheme | null = null,
): WorkbenchTheme {
  if (override) return override;
  if (preference === "daylight") return "daylight";
  if (preference === "graphite") return "graphite";
  return systemPrefersLight ? "daylight" : "graphite";
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readSystemPrefersLight(): boolean {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(prefers-color-scheme: light)").matches;
  } catch {
    return false;
  }
}

export function readStoredThemePreference(storage: StorageLike | null = safeStorage()): ThemePreference {
  if (!storage) return "graphite";
  try {
    return parseThemePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "graphite";
  }
}

export function writeStoredThemePreference(
  preference: ThemePreference,
  storage: StorageLike | null = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // 存储受限时保留内存态切换
  }
}

function readLocationSearch(): string | null {
  try {
    if (typeof window === "undefined" || !window.location) return null;
    return window.location.search || null;
  } catch {
    return null;
  }
}

let currentPreference: ThemePreference = readStoredThemePreference();
let currentSystemLight: boolean = readSystemPrefersLight();
let currentUrlOverride: WorkbenchTheme | null = parseThemeOverrideFromSearch(readLocationSearch());
let initialized = false;
let lastSyncedNativeTheme: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function syncNativeWindowTheme(theme: WorkbenchTheme): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  const preference = currentUrlOverride ?? currentPreference;
  const key = `${preference}:${theme}`;
  if (lastSyncedNativeTheme === key) return;
  lastSyncedNativeTheme = key;
  void invoke("sync_window_theme", { theme, preference });
}

function applyThemeToDocument(theme: WorkbenchTheme): void {
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.classList.toggle("dark", theme === "graphite");
    root.style.colorScheme = theme === "daylight" ? "light" : "dark";
  }
  syncNativeWindowTheme(theme);
}

function syncDocument() {
  applyThemeToDocument(resolveWorkbenchTheme(currentPreference, currentSystemLight, currentUrlOverride));
}

export function initTheme(): void {
  currentPreference = readStoredThemePreference();
  currentSystemLight = readSystemPrefersLight();
  currentUrlOverride = parseThemeOverrideFromSearch(readLocationSearch());
  syncDocument();

  if (initialized || typeof window === "undefined") return;
  initialized = true;

  try {
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    media?.addEventListener?.("change", (event) => {
      const nextLight = Boolean(event.matches);
      if (currentSystemLight === nextLight) return;
      currentSystemLight = nextLight;
      syncDocument();
      emit();
    });
  } catch {
    // 忽略测试环境无 matchMedia
  }

  window.addEventListener?.("storage", (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    const next = parseThemePreference(event.newValue);
    if (currentPreference === next) return;
    currentPreference = next;
    syncDocument();
    emit();
  });
}

function getThemePreference(): ThemePreference {
  return currentPreference;
}

function getResolvedTheme(): WorkbenchTheme {
  return resolveWorkbenchTheme(currentPreference, currentSystemLight, currentUrlOverride);
}

export function setThemePreference(next: ThemePreference): void {
  currentUrlOverride = null;
  writeStoredThemePreference(next);
  if (currentPreference === next) {
    syncDocument();
    emit();
    return;
  }
  currentPreference = next;
  syncDocument();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme() {
  const preference = useSyncExternalStore<ThemePreference>(
    subscribe,
    getThemePreference,
    () => "graphite",
  );
  const theme = useSyncExternalStore<WorkbenchTheme>(
    subscribe,
    getResolvedTheme,
    () => "graphite",
  );
  return {
    preference,
    theme,
    setPreference: setThemePreference,
  };
}
