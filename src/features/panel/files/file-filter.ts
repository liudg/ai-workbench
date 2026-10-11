import { useSyncExternalStore } from "react";

let filter = "";
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getFileFilter(): string {
  return filter;
}

export function setFileFilter(next: string): void {
  if (next === filter) return;
  filter = next;
  emit();
}

export function subscribeFileFilter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 差异页文件栏和「会话文件」共用这一条筛选。 */
export function useFileFilter(): readonly [string, (next: string) => void] {
  const value = useSyncExternalStore(subscribeFileFilter, getFileFilter, getFileFilter);
  return [value, setFileFilter];
}

export function filterFiles<T extends { path: string }>(files: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files.slice();
  return files.filter((file) => file.path.toLowerCase().includes(needle));
}
