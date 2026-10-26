// 会话时间线的本地副本。每个会话只向 daemon 订阅一次，事件按 seq 合并：
// 同一 seq 的新推送（流式覆盖）替换旧的。断线重连时带上已有的最大 rev，只补之后的。
// 最后一个观察者离开后保留副本，下次打开同一个会话只补差。

import type { QueuedTurn, SessionEvent } from "@/types";

import type { DaemonClient } from "./client";
import { sessionTopic } from "./topics.ts";

export type StoredEvent = SessionEvent & { rev: number };

interface FeedPush {
  reset?: boolean;
  events?: StoredEvent[];
  queue?: QueuedTurn[];
}

export interface SessionFeedState {
  /** 收到第一份快照之前为 false。 */
  ready: boolean;
  events: SessionEvent[];
  queue: QueuedTurn[];
}

const EMPTY: SessionFeedState = { ready: false, events: [], queue: [] };

interface Entry {
  maxRev: number;
  state: SessionFeedState;
  watchers: Set<() => void>;
  unsubscribe: (() => void) | null;
  release: ReturnType<typeof setTimeout> | null;
}

export class SessionFeeds {
  private readonly entries = new Map<string, Entry>();
  private readonly client: Pick<DaemonClient, "subscribe">;

  constructor(client: Pick<DaemonClient, "subscribe">) {
    this.client = client;
  }

  get(sessionId: string): SessionFeedState {
    return this.entries.get(sessionId)?.state ?? EMPTY;
  }

  watch(sessionId: string, onChange: () => void): () => void {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { maxRev: 0, state: EMPTY, watchers: new Set(), unsubscribe: null, release: null };
      this.entries.set(sessionId, entry);
    }
    const watched = entry;
    if (watched.release) clearTimeout(watched.release);
    watched.release = null;
    if (!watched.unsubscribe) {
      watched.unsubscribe = this.client.subscribe(
        sessionTopic(sessionId),
        (data) => this.apply(watched, data as FeedPush),
        () => ({ fromRev: watched.maxRev }),
      );
    }
    watched.watchers.add(onChange);
    return () => {
      watched.watchers.delete(onChange);
      if (watched.watchers.size > 0 || watched.release) return;
      // React 重新挂载时马上又会回来，等一拍再退订。
      watched.release = setTimeout(() => {
        watched.release = null;
        if (watched.watchers.size > 0) return;
        watched.unsubscribe?.();
        watched.unsubscribe = null;
      }, 0);
    };
  }

  private apply(entry: Entry, push: FeedPush) {
    let events = push.reset ? [] : entry.state.events;
    if (push.reset) entry.maxRev = 0;
    const incoming = push.events ?? [];
    if (incoming.length > 0) {
      events = [...events];
      for (const event of incoming) {
        upsertBySeq(events, event);
        if (event.rev > entry.maxRev) entry.maxRev = event.rev;
      }
    }
    entry.state = { ready: true, events, queue: push.queue ?? entry.state.queue };
    for (const watcher of entry.watchers) watcher();
  }
}

/** 按 seq 有序插入；同一 seq 替换。流式输出几乎总是改最后几条，从尾部往前找。 */
export function upsertBySeq(events: SessionEvent[], event: SessionEvent) {
  let index = events.length - 1;
  while (index >= 0 && events[index].seq > event.seq) index -= 1;
  if (index >= 0 && events[index].seq === event.seq) events[index] = event;
  else events.splice(index + 1, 0, event);
}
