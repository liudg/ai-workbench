const cache = new Map<string, string | null>();
const generation = new Map<string, number>();
const listeners = new Set<(projectId: string) => void>();

function branchName(value: string | null | undefined): string | null {
  const name = value?.trim() ?? "";
  if (!name || name === "HEAD") return null;
  return name;
}

export function projectBranchStamp(projectId: string): number {
  return generation.get(projectId) ?? 0;
}

export function cachedProjectBranch(projectId: string): string | null | undefined {
  return cache.get(projectId);
}

/** 检出或轮询拿到新分支后通知侧栏。同名不重复通知。 */
export function rememberProjectBranch(projectId: string, value: string | null | undefined) {
  if (!projectId) return;
  const next = branchName(value);
  const known = cache.has(projectId);
  const prev = cache.get(projectId) ?? null;
  generation.set(projectId, (generation.get(projectId) ?? 0) + 1);
  cache.set(projectId, next);
  if (known && prev === next) return;
  for (const listener of listeners) listener(projectId);
}

export function subscribeProjectBranch(listener: (projectId: string) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
