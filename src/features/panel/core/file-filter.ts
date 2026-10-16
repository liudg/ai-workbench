import { useCallback, useSyncExternalStore } from "react";

const filters = new Map<string, string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getFileFilter(sessionId: string): string {
  return filters.get(sessionId) ?? "";
}

export function setFileFilter(sessionId: string, next: string): void {
  const current = filters.get(sessionId) ?? "";
  if (next === current) return;
  if (next) filters.set(sessionId, next);
  else filters.delete(sessionId);
  emit();
}

export function resetFileFilters(): void {
  filters.clear();
  emit();
}

export function subscribeFileFilter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 同一个会话里的差异文件栏共用这一条筛选。别的会话互不影响。 */
export function useFileFilter(sessionId: string): readonly [string, (next: string) => void] {
  const value = useSyncExternalStore(
    subscribeFileFilter,
    () => getFileFilter(sessionId),
    () => getFileFilter(sessionId),
  );
  const set = useCallback((next: string) => setFileFilter(sessionId, next), [sessionId]);
  return [value, set];
}

export function filterFiles<T extends { path: string }>(files: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files.slice();
  return files.filter((file) => file.path.toLowerCase().includes(needle));
}
