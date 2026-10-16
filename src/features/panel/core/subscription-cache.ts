import { backend } from "@/lib/ipc";
import type { AgentKind, SubscriptionUsage } from "@/types";

const cache = new Map<string, SubscriptionUsage>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let revision = 0;

function emit() {
  revision += 1;
  for (const listener of listeners) listener();
}

export function subscribeSubscriptionUsage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscriptionUsageRevision(): number {
  return revision;
}

export function peekSubscriptionUsage(kind: string): SubscriptionUsage | undefined {
  return cache.get(kind);
}

/** 预览把窗口放进和真实拉取同一份缓存，切换布局不会再请求。 */
export function seedSubscriptionUsage(kind: string, usage: SubscriptionUsage) {
  cache.set(kind, usage);
  emit();
}

/** 同一 agent 的在途请求合并。失败时保留上一份成功结果。 */
export function refreshSubscriptionUsage(kind: AgentKind): Promise<void> {
  const pending = inflight.get(kind);
  if (pending) return pending;
  const task = backend
    .subscriptionUsage(kind)
    .then((usage) => {
      cache.set(kind, usage);
      emit();
    })
    .catch(() => {
      // 拉取失败时界面继续显示上一份。
    })
    .finally(() => {
      inflight.delete(kind);
    });
  inflight.set(kind, task);
  return task;
}
