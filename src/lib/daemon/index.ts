// 全应用共用一条 daemon 连接。界面通过各功能的 hook 用它，展示组件不直接引用。

import { useCallback, useRef, useSyncExternalStore } from "react";

import { DaemonClient, type ConnectionStatus } from "./client";
import { resolveEndpoint } from "./endpoint";
import { SessionFeeds, type SessionFeedState } from "./session-feed";
import { TopicCache } from "./topic-cache";

export { DaemonClient, OFFLINE_MESSAGE, type ConnectionStatus, type DaemonEndpoint } from "./client";
export { TOPIC_AGENT_UPGRADES, TOPIC_PROJECTS, TOPIC_TASKS } from "./topics";
export type { SessionFeedState } from "./session-feed";

/** 要等 Agent CLI 起来并回话的调用。CLI 启动或重连时会慢。 */
export const CLI_TIMEOUT_MS = 90_000;

export const daemon = new DaemonClient({ resolveEndpoint });
const topics = new TopicCache(daemon);
const feeds = new SessionFeeds(daemon);

/** 开发样例页：不连 daemon，主题用给定的值，调用直接失败。只从开发入口调用。 */
export function startPreview(values: Record<string, unknown>) {
  daemon.disable("样例页不连后台服务");
  for (const [topic, value] of Object.entries(values)) topics.seed(topic, value);
}

const watchStatus = (onChange: () => void) => daemon.onStatus(onChange);
const readStatus = () => daemon.getStatus();

/** 连接状态。第一次调用时开始连接。 */
export function useConnectionStatus(): ConnectionStatus {
  daemon.start();
  return useSyncExternalStore(watchStatus, readStatus);
}

/** 主题的当前值。还没收到第一份快照时是 undefined。 */
export function useTopic<T>(topic: string): T | undefined {
  daemon.start();
  const watch = useCallback((onChange: () => void) => topics.watch(topic, onChange), [topic]);
  const read = useCallback(() => topics.get(topic) as T | undefined, [topic]);
  return useSyncExternalStore(watch, read);
}

/** 一个会话的时间线和排队。断线重连后只补缺的那段。 */
export function useSessionFeed(sessionId: string): SessionFeedState {
  daemon.start();
  const watch = useCallback((onChange: () => void) => feeds.watch(sessionId, onChange), [sessionId]);
  const read = useCallback(() => feeds.get(sessionId), [sessionId]);
  return useSyncExternalStore(watch, read);
}

/** 几个会话的时间线，顺序同 `sessionIds`。任务换过 Agent 时，前面几段一起显示。 */
export function useSessionFeeds(sessionIds: readonly string[]): SessionFeedState[] {
  daemon.start();
  const key = sessionIds.join(",");
  const last = useRef<SessionFeedState[]>([]);
  const watch = useCallback(
    (onChange: () => void) => {
      const stops = key ? key.split(",").map((id) => feeds.watch(id, onChange)) : [];
      return () => stops.forEach((stop) => stop());
    },
    [key],
  );
  const read = useCallback(() => {
    const next = key ? key.split(",").map((id) => feeds.get(id)) : [];
    const prev = last.current;
    if (prev.length === next.length && prev.every((state, index) => state === next[index])) return prev;
    last.current = next;
    return next;
  }, [key]);
  return useSyncExternalStore(watch, read);
}
