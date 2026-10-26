import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionFeeds, type StoredEvent } from "./session-feed.ts";
import type { SubscribeParams } from "./client.ts";

function fakeClient() {
  const subs: { topic: string; listener: (data: unknown) => void; params?: SubscribeParams; live: boolean }[] = [];
  return {
    subs,
    subscribe(topic: string, listener: (data: unknown) => void, params?: SubscribeParams) {
      const sub = { topic, listener, params, live: true };
      subs.push(sub);
      return () => {
        sub.live = false;
      };
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function message(seq: number, rev: number, text: string): StoredEvent {
  return { id: `e${seq}`, session_id: "s", seq, ts: 0, rev, kind: "system", text } as StoredEvent;
}

test("同一 seq 的推送替换旧的，按 seq 排序，记下最大 rev", () => {
  const client = fakeClient();
  const feeds = new SessionFeeds(client);
  let changes = 0;
  feeds.watch("s", () => changes++);
  assert.equal(client.subs[0].topic, "session:s");
  assert.deepEqual(client.subs[0].params?.(), { fromRev: 0 });
  assert.equal(feeds.get("s").ready, false);

  client.subs[0].listener({ reset: true, events: [message(1, 1, "一"), message(2, 2, "二")], queue: [] });
  client.subs[0].listener({ events: [message(2, 3, "二改")] });
  client.subs[0].listener({ events: [message(3, 4, "三")] });
  const state = feeds.get("s");
  assert.equal(state.ready, true);
  assert.deepEqual(
    state.events.map((e) => (e as { text: string }).text),
    ["一", "二改", "三"],
  );
  assert.deepEqual(client.subs[0].params?.(), { fromRev: 4 });
  assert.equal(changes, 3);

  // 只有排队变化时事件数组保持同一个引用。
  const before = feeds.get("s").events;
  client.subs[0].listener({ queue: [{ id: "q", text: "后续" }] });
  assert.equal(feeds.get("s").events, before);
  assert.equal(feeds.get("s").queue.length, 1);

  client.subs[0].listener({ reset: true, events: [message(1, 9, "重来")] });
  assert.equal(feeds.get("s").events.length, 1);
  assert.deepEqual(client.subs[0].params?.(), { fromRev: 9 });
});

test("离开后保留副本，再打开只补差", async () => {
  const client = fakeClient();
  const feeds = new SessionFeeds(client);
  const stop = feeds.watch("s", () => {});
  client.subs[0].listener({ reset: true, events: [message(1, 5, "一")] });
  stop();
  await flush();
  assert.equal(client.subs[0].live, false);
  assert.equal(feeds.get("s").events.length, 1);

  feeds.watch("s", () => {});
  assert.equal(client.subs.length, 2);
  assert.deepEqual(client.subs[1].params?.(), { fromRev: 5 });
});
