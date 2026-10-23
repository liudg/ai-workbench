// 全应用共用一条 daemon 连接。界面通过各功能的 hook 用它，展示组件不直接引用。

import { useCallback, useSyncExternalStore } from "react";

import { DaemonClient, type ConnectionStatus } from "./client";
import { resolveEndpoint } from "./endpoint";
import { TopicCache } from "./topic-cache";

export { DaemonClient, OFFLINE_MESSAGE, type ConnectionStatus, type DaemonEndpoint } from "./client";
export { TOPIC_PROJECTS } from "./topics";

export const daemon = new DaemonClient({ resolveEndpoint });
const topics = new TopicCache(daemon);

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
