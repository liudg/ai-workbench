import {
  effectiveInstanceId,
  nonDefaultInstanceId,
  type AgentKind,
  type SubscriptionUsage,
} from "../../../types/index.ts";

const cache = new Map<string, SubscriptionUsage>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let revision = 0;

function emit() {
  revision += 1;
  for (const listener of listeners) listener();
}

export function clearSubscriptionUsageCache(): void {
  cache.clear();
  inflight.clear();
  emit();
}

export function evictSubscriptionUsage(kind: AgentKind, instanceId?: string | null): void {
  const key = effectiveInstanceId(kind, instanceId);
  const hadCache = cache.delete(key);
  const hadInflight = inflight.delete(key);
  if (hadCache || hadInflight) {
    emit();
  }
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

export function peekSubscriptionUsage(
  kind: AgentKind,
  instanceId?: string | null,
): SubscriptionUsage | undefined {
  return cache.get(effectiveInstanceId(kind, instanceId));
}

/** 预览把窗口放进和真实拉取同一份缓存，切换布局不会再请求。 */
export function seedSubscriptionUsage(
  kind: AgentKind,
  usage: SubscriptionUsage,
  instanceId?: string | null,
) {
  cache.set(effectiveInstanceId(kind, instanceId), usage);
  emit();
}

/** 同一实例的在途请求合并，不跨实例混用。失败时保留上一份成功结果。 */
export function refreshSubscriptionUsage(
  kind: AgentKind,
  fetch: (kind: AgentKind, instanceId?: string) => Promise<SubscriptionUsage>,
  instanceId?: string | null,
): Promise<void> {
  const key = effectiveInstanceId(kind, instanceId);
  const nonDefault = nonDefaultInstanceId(kind, instanceId);
  const pending = inflight.get(key);
  if (pending) return pending;
  const call = nonDefault ? fetch(kind, nonDefault) : fetch(kind);
  const task = call
    .then((usage) => {
      if (inflight.get(key) !== task) return;
      cache.set(key, usage);
      emit();
    })
    .catch(() => {
      // 拉取失败时界面继续显示上一份。
    })
    .finally(() => {
      if (inflight.get(key) === task) {
        inflight.delete(key);
      }
    });
  inflight.set(key, task);
  return task;
}
