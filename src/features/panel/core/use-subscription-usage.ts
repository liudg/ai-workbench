import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  formatSubscriptionHeadline,
  pickTightestWindow,
  remainingPercent,
  shouldRefreshAfterStatus,
  subscriptionTone,
  windowsForModel,
} from "@/store/subscription-usage";
import { effectiveInstanceId, type AgentKind, type SessionStatus } from "@/types";
import {
  peekSubscriptionUsage,
  refreshSubscriptionUsage,
  subscribeSubscriptionUsage,
  subscriptionUsageRevision,
} from "./subscription-cache";
import { usePanel } from "./PanelProvider";

const TICK_MS = 30_000;
/** setTimeout 超过这个值会在浏览器里立刻触发。更长的等待靠本地计时重新安排。 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** 顶栏显示当前模型所在窗口里最紧的一个；按实例隔离缓存与查询，悬停仍列出全部窗口。 */
export function useSubscriptionUsage(
  agent: AgentKind | null,
  modelLabel: string | null,
  instanceId?: string | null,
) {
  const {
    subscriptionSupported: supported,
    modelLoading,
    status,
    data,
    instanceId: panelInstanceId,
  } = usePanel();

  const resolvedInstanceId = instanceId?.trim() || panelInstanceId?.trim() || undefined;

  const fetch = useCallback(
    (kind: AgentKind, nonDefaultId?: string) => data.subscriptionUsage(kind, nonDefaultId),
    [data],
  );

  useSyncExternalStore(
    subscribeSubscriptionUsage,
    subscriptionUsageRevision,
    subscriptionUsageRevision,
  );
  const instanceKey = agent ? effectiveInstanceId(agent, resolvedInstanceId) : null;
  const usage =
    agent && supported ? peekSubscriptionUsage(agent, resolvedInstanceId) : undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!agent || !supported || peekSubscriptionUsage(agent, resolvedInstanceId)) return;
    void refreshSubscriptionUsage(agent, fetch, resolvedInstanceId);
  }, [agent, fetch, instanceKey, resolvedInstanceId, supported]);

  const previous = useRef<SessionStatus | undefined>(status);
  useEffect(() => {
    const before = previous.current;
    previous.current = status;
    if (!agent || !supported) return;
    if (shouldRefreshAfterStatus(before, status)) {
      void refreshSubscriptionUsage(agent, fetch, resolvedInstanceId);
    }
  }, [agent, fetch, instanceKey, resolvedInstanceId, supported, status]);

  const tight = usage
    ? pickTightestWindow(windowsForModel(usage.windows, modelLoading ? undefined : modelLabel))
    : null;
  const resetAt = typeof tight?.resets_at_ms === "number" ? tight.resets_at_ms : null;
  const refreshedReset = useRef<string | null>(null);
  useEffect(() => {
    if (!agent || !supported || resetAt === null) return;
    const token = `${instanceKey}:${resetAt}`;
    const delay = resetAt - Date.now();
    if (delay <= 0) {
      if (refreshedReset.current !== token) {
        refreshedReset.current = token;
        void refreshSubscriptionUsage(agent, fetch, resolvedInstanceId);
      }
      return;
    }
    if (delay > MAX_TIMEOUT_MS) return;
    const id = window.setTimeout(() => {
      refreshedReset.current = token;
      void refreshSubscriptionUsage(agent, fetch, resolvedInstanceId);
    }, delay);
    return () => window.clearTimeout(id);
  }, [agent, fetch, instanceKey, resolvedInstanceId, supported, resetAt, now]);

  const remaining = tight ? remainingPercent(tight) : null;
  return {
    headline: tight ? formatSubscriptionHeadline(tight, now) : null,
    windows: usage?.windows ?? [],
    now,
    tone: remaining === null ? "normal" : subscriptionTone(remaining),
    remaining,
    refresh() {
      if (agent && supported) void refreshSubscriptionUsage(agent, fetch, resolvedInstanceId);
    },
  };
}
