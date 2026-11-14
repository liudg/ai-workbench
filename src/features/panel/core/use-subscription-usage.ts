import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  formatSubscriptionHeadline,
  pickTightestWindow,
  remainingPercent,
  shouldRefreshAfterStatus,
  subscriptionTone,
  windowsForModel,
} from "@/store/subscription-usage";
import type { AgentKind, SessionStatus } from "@/types";
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

/** 顶栏显示当前模型所在窗口里最紧的一个；悬停仍列出全部窗口。 */
export function useSubscriptionUsage(agent: AgentKind | null, modelLabel: string | null) {
  const { subscriptionSupported: supported, status, data } = usePanel();
  const fetch = data.subscriptionUsage;
  useSyncExternalStore(subscribeSubscriptionUsage, subscriptionUsageRevision, subscriptionUsageRevision);
  const usage = agent && supported ? peekSubscriptionUsage(agent) : undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!agent || !supported || peekSubscriptionUsage(agent)) return;
    void refreshSubscriptionUsage(agent, fetch);
  }, [agent, fetch, supported]);

  const previous = useRef<SessionStatus | undefined>(status);
  useEffect(() => {
    const before = previous.current;
    previous.current = status;
    if (!agent || !supported) return;
    if (shouldRefreshAfterStatus(before, status)) void refreshSubscriptionUsage(agent, fetch);
  }, [agent, fetch, supported, status]);

  const tight = usage ? pickTightestWindow(windowsForModel(usage.windows, modelLabel)) : null;
  const resetAt = typeof tight?.resets_at_ms === "number" ? tight.resets_at_ms : null;
  const refreshedReset = useRef<number | null>(null);
  useEffect(() => {
    if (!agent || !supported || resetAt === null) return;
    const delay = resetAt - Date.now();
    if (delay <= 0) {
      if (refreshedReset.current !== resetAt) {
        refreshedReset.current = resetAt;
        void refreshSubscriptionUsage(agent, fetch);
      }
      return;
    }
    if (delay > MAX_TIMEOUT_MS) return;
    const id = window.setTimeout(() => {
      refreshedReset.current = resetAt;
      void refreshSubscriptionUsage(agent, fetch);
    }, delay);
    return () => window.clearTimeout(id);
  }, [agent, fetch, supported, resetAt, now]);

  const remaining = tight ? remainingPercent(tight) : null;
  return {
    headline: tight ? formatSubscriptionHeadline(tight, now) : null,
    windows: usage?.windows ?? [],
    now,
    tone: remaining === null ? "normal" : subscriptionTone(remaining),
    remaining,
    refresh() {
      if (agent && supported) void refreshSubscriptionUsage(agent, fetch);
    },
  };
}
