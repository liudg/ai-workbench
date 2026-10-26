// 全应用共用一条 daemon 连接。界面通过各功能的 hook 用它，展示组件不直接引用。

import { useCallback, useSyncExternalStore } from "react";

import { DaemonClient, type ConnectionStatus } from "./client";
import { resolveEndpoint } from "./endpoint";
import { SessionFeeds, type SessionFeedState } from "./session-feed";
import { TopicCache } from "./topic-cache";

export { DaemonClient, OFFLINE_MESSAGE, type ConnectionStatus, type DaemonEndpoint } from "./client";
export { TOPIC_PROJECTS, TOPIC_TASKS } from "./topics";
export type { SessionFeedState } from "./session-feed";

export const daemon = new DaemonClient({ resolveEndpoint });
const topics = new TopicCache(daemon);
const feeds = new SessionFeeds(daemon);

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
