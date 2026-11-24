// 订阅 daemon `keybindings` 主题并提供 RPC 读写封装；未连上 daemon 或单测环境下优雅回退到 DEFAULT_KEYBINDINGS。

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { daemon } from "@/lib/daemon";
import { TOPIC_KEYBINDINGS } from "@/lib/daemon/topics";
import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  formatCommandShortcut,
  resolveKeybindings,
} from "./defaults.ts";
import { detectShortcutPlatform } from "./shortcut.ts";
import type {
  KeybindingRule,
  KeybindingsSnapshot,
  ResolvedKeybindingRule,
  ShortcutPlatform,
} from "./types.ts";

const EMPTY_SNAPSHOT: KeybindingsSnapshot = {
  path: "",
  rules: [],
  error: null,
};

let currentSnapshot: KeybindingsSnapshot | null = null;
let cachedResolved: readonly ResolvedKeybindingRule[] = DEFAULT_RESOLVED_KEYBINDINGS;
let cachedPlatform: ShortcutPlatform = detectShortcutPlatform();
let passiveSubscribed = false;
const listeners = new Set<() => void>();

function normalizeRule(raw: unknown): KeybindingRule | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.command !== "string") return null;
  const key = typeof record.key === "string" ? record.key : "";
  const when = typeof record.when === "string" && record.when.trim().length > 0 ? record.when : undefined;
  return when !== undefined ? { command: record.command, key, when } : { command: record.command, key };
}

function normalizeKeybindingsSnapshot(raw: unknown): KeybindingsSnapshot {
  if (Array.isArray(raw)) {
    return {
      path: currentSnapshot?.path ?? "",
      rules: raw.map(normalizeRule).filter((item): item is KeybindingRule => item !== null),
      error: null,
    };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const rules = Array.isArray(obj.rules)
      ? obj.rules.map(normalizeRule).filter((item): item is KeybindingRule => item !== null)
      : [];
    return {
      path: typeof obj.path === "string" ? obj.path : (currentSnapshot?.path ?? ""),
      rules,
      error: typeof obj.error === "string" && obj.error.trim().length > 0 ? obj.error : null,
    };
  }
  return EMPTY_SNAPSHOT;
}

function snapshotsEqual(a: KeybindingsSnapshot | null, b: KeybindingsSnapshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.path !== b.path || a.error !== b.error || a.rules.length !== b.rules.length) {
    return false;
  }
  for (let i = 0; i < a.rules.length; i += 1) {
    const ra = a.rules[i]!;
    const rb = b.rules[i]!;
    if (ra.command !== rb.command || ra.key !== rb.key || (ra.when ?? "") !== (rb.when ?? "")) {
      return false;
    }
  }
  return true;
}

function updateSnapshot(next: KeybindingsSnapshot | null) {
  const platform = detectShortcutPlatform();
  if (platform === cachedPlatform && snapshotsEqual(currentSnapshot, next)) {
    return;
  }
  currentSnapshot = next;
  cachedPlatform = platform;
  cachedResolved = next
    ? resolveKeybindings(DEFAULT_KEYBINDINGS, next.rules, platform)
    : platform === "windows"
      ? DEFAULT_RESOLVED_KEYBINDINGS
      : resolveKeybindings(DEFAULT_KEYBINDINGS, [], platform);
  for (const listener of listeners) listener();
}

function ensurePassiveSubscription() {
  if (passiveSubscribed) return;
  passiveSubscribed = true;
  // 注意：只挂订阅回调，不在此处主动调 daemon.start()，避免纯单测进程被重连定时器挂住。
  daemon.subscribe(TOPIC_KEYBINDINGS, (raw) => {
    updateSnapshot(normalizeKeybindingsSnapshot(raw));
  });
}

function subscribeStore(listener: () => void): () => void {
  ensurePassiveSubscription();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getKeybindingsSnapshot(): KeybindingsSnapshot {
  ensurePassiveSubscription();
  return currentSnapshot ?? EMPTY_SNAPSHOT;
}

export function hasKeybindingsSnapshot(): boolean {
  ensurePassiveSubscription();
  return currentSnapshot !== null;
}

export function getResolvedKeybindings(
  platform: ShortcutPlatform = detectShortcutPlatform(),
): readonly ResolvedKeybindingRule[] {
  ensurePassiveSubscription();
  if (platform !== cachedPlatform) {
    return resolveKeybindings(DEFAULT_KEYBINDINGS, currentSnapshot?.rules ?? [], platform);
  }
  return cachedResolved;
}

export async function fetchKeybindings(): Promise<KeybindingsSnapshot> {
  ensurePassiveSubscription();
  daemon.start();
  const raw = await daemon.call<{ path: string; rules: KeybindingRule[]; error?: string | null }>(
    "settings.keybindings",
  );
  const normalized = normalizeKeybindingsSnapshot(raw);
  updateSnapshot(normalized);
  return currentSnapshot ?? normalized;
}

export async function saveKeybindings(rules: readonly KeybindingRule[]): Promise<KeybindingsSnapshot> {
  ensurePassiveSubscription();
  daemon.start();
  const cleanRules: KeybindingRule[] = rules.map((rule) =>
    rule.when && rule.when.trim()
      ? { command: rule.command, key: rule.key, when: rule.when.trim() }
      : { command: rule.command, key: rule.key },
  );
  const raw = await daemon.call<unknown>("settings.setKeybindings", { rules: cleanRules });
  const next =
    raw && typeof raw === "object" && ("rules" in raw || "path" in raw)
      ? normalizeKeybindingsSnapshot(raw)
      : { path: currentSnapshot?.path ?? "", rules: cleanRules, error: null };
  updateSnapshot(next);
  return currentSnapshot ?? next;
}

/** 在挂载 daemon 连接的宿主里启用单一 `keybindings` 主题订阅并读取当前快照。 */
export function useKeybindingsTopicSync(): KeybindingsSnapshot {
  useEffect(() => {
    ensurePassiveSubscription();
    daemon.start();
  }, []);
  return useSyncExternalStore(subscribeStore, getKeybindingsSnapshot, () => EMPTY_SNAPSHOT);
}

/** 读取当前生效的快捷键列表（自动回退 DEFAULT_KEYBINDINGS，不强制拉起 daemon 连接）。 */
export function useResolvedKeybindings(): readonly ResolvedKeybindingRule[] {
  return useSyncExternalStore(
    subscribeStore,
    () => getResolvedKeybindings(),
    () => DEFAULT_RESOLVED_KEYBINDINGS,
  );
}

/** 读取指定命令当前生效的格式化快捷键文案。 */
export function useCommandShortcut(
  commandId: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string | undefined {
  const rules = useResolvedKeybindings();
  return useMemo(() => formatCommandShortcut(commandId, rules, platform), [commandId, platform, rules]);
}
