// 主题值的缓存，给 useSyncExternalStore 用：同一个主题只向 daemon 订阅一次。
// 最后一个观察者离开后等一拍再退订：React 重新挂载（StrictMode、切换视图）时马上又会回来，
// 不必为此退订再重订、丢掉已有的值。

import type { DaemonClient } from "./client";

interface Entry {
  value: unknown;
  watchers: Set<() => void>;
  unsubscribe: () => void;
  release: ReturnType<typeof setTimeout> | null;
  fixed?: boolean;
}

export class TopicCache {
  private readonly entries = new Map<string, Entry>();
  private readonly client: Pick<DaemonClient, "subscribe">;

  constructor(client: Pick<DaemonClient, "subscribe">) {
    this.client = client;
  }

  /** 固定一个主题的值，不向 daemon 订阅。开发样例页用。 */
  seed(topic: string, value: unknown) {
    this.entries.set(topic, { value, watchers: new Set(), unsubscribe: () => {}, release: null, fixed: true });
  }

  get(topic: string): unknown {
    return this.entries.get(topic)?.value;
  }

  watch(topic: string, onChange: () => void): () => void {
    let entry = this.entries.get(topic);
    if (!entry) {
      const created: Entry = { value: undefined, watchers: new Set(), unsubscribe: () => {}, release: null };
      this.entries.set(topic, created);
      created.unsubscribe = this.client.subscribe(topic, (data) => {
        created.value = data;
        for (const watcher of created.watchers) watcher();
      });
      entry = created;
    }
    if (entry.release) clearTimeout(entry.release);
    entry.release = null;
    entry.watchers.add(onChange);
    const watched = entry;
    return () => {
      watched.watchers.delete(onChange);
      if (watched.watchers.size > 0 || watched.release || watched.fixed) return;
      watched.release = setTimeout(() => {
        watched.release = null;
        if (watched.watchers.size > 0 || this.entries.get(topic) !== watched) return;
        this.entries.delete(topic);
        watched.unsubscribe();
      }, 0);
    };
  }
}
