import assert from "node:assert/strict";
import { test } from "node:test";

import { DaemonClient, type SocketLike } from "./client.ts";
import { TopicCache } from "./topic-cache.ts";

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const sockets: FakeSocket[] = [];
  const client = new DaemonClient({
    resolveEndpoint: async () => ({ url: "ws://127.0.0.1:1/ws", token: "a b" }),
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    retryDelay: () => 0,
    callTimeoutMs: 1000,
  });
  return { client, sockets };
}

test("连上之前的调用在连上后发出，并按 id 收到结果", async () => {
  const { client, sockets } = setup();
  client.start();
  const result = client.call<number>("projects.list");
  await flush();
  assert.equal(sockets[0].url, "ws://127.0.0.1:1/ws?token=a%20b");
  assert.equal(sockets[0].sent.length, 0);

  sockets[0].open();
  assert.equal(client.getStatus(), "online");
  assert.deepEqual(sockets[0].sent[0], { id: 1, method: "projects.list", params: {} });
  sockets[0].receive({ id: 1, result: 42 });
  assert.equal(await result, 42);
  client.stop();
});

test("错误响应变成 Error", async () => {
  const { client, sockets } = setup();
  client.start();
  await flush();
  sockets[0].open();
  const result = client.call("nope");
  sockets[0].receive({ id: 1, error: { message: "没有这个方法：nope" } });
  await assert.rejects(result, /没有这个方法/);
  client.stop();
});

test("断线后已发出的调用失败，重连后重新订阅", async () => {
  const { client, sockets } = setup();
  const seen: unknown[] = [];
  client.subscribe("projects", (data) => seen.push(data));
  client.start();
  await flush();
  sockets[0].open();
  assert.deepEqual(sockets[0].sent[0], { id: 1, method: "subscribe", params: { topic: "projects" } });
  sockets[0].receive({ topic: "projects", data: [1] });

  const inflight = client.call("projects.list");
  sockets[0].drop();
  await assert.rejects(inflight, /断开/);

  await flush();
  await flush();
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.equal(sockets[1].sent[0].method, "subscribe");
  sockets[1].receive({ topic: "projects", data: [1, 2] });
  assert.deepEqual(seen, [[1], [1, 2]]);
  client.stop();
});

test("订阅参数在每次重连时重新取", async () => {
  const { client, sockets } = setup();
  let fromRev = 0;
  client.subscribe("session:s", () => {}, () => ({ fromRev }));
  client.start();
  await flush();
  sockets[0].open();
  assert.deepEqual(sockets[0].sent[0].params, { fromRev: 0, topic: "session:s" });
  fromRev = 7;
  sockets[0].drop();
  await flush();
  await flush();
  sockets[1].open();
  assert.deepEqual(sockets[1].sent[0].params, { fromRev: 7, topic: "session:s" });
  client.stop();
});

test("后加入的监听者先拿到最近的值；最后一个离开时退订", async () => {
  const { client, sockets } = setup();
  client.start();
  await flush();
  sockets[0].open();
  const first: unknown[] = [];
  const stopFirst = client.subscribe("projects", (data) => first.push(data));
  sockets[0].receive({ topic: "projects", data: ["a"] });

  const second: unknown[] = [];
  const stopSecond = client.subscribe("projects", (data) => second.push(data));
  assert.deepEqual(second, [["a"]]);
  assert.equal(sockets[0].sent.filter((m) => m.method === "subscribe").length, 1);

  stopFirst();
  stopSecond();
  assert.equal(sockets[0].sent[sockets[0].sent.length - 1]?.method, "unsubscribe");
  sockets[0].receive({ topic: "projects", data: ["b"] });
  assert.deepEqual(first, [["a"]]);
  client.stop();
});

test("TopicCache 只订阅一次，并通知所有观察者", async () => {
  const listeners: ((data: unknown) => void)[] = [];
  let unsubscribed = 0;
  const cache = new TopicCache({
    subscribe: (_topic, listener) => {
      listeners.push(listener);
      return () => {
        unsubscribed += 1;
      };
    },
  });
  let a = 0;
  let b = 0;
  const stopA = cache.watch("projects", () => (a += 1));
  const stopB = cache.watch("projects", () => (b += 1));
  assert.equal(listeners.length, 1);
  assert.equal(cache.get("projects"), undefined);

  listeners[0](["x"]);
  assert.deepEqual(cache.get("projects"), ["x"]);
  assert.equal(a + b, 2);

  stopA();
  stopB();
  assert.equal(unsubscribed, 0);
  await flush();
  assert.equal(unsubscribed, 1);
  assert.equal(cache.get("projects"), undefined);
});

test("TopicCache 观察者马上回来时不退订，值还在", async () => {
  const listeners: ((data: unknown) => void)[] = [];
  let unsubscribed = 0;
  const cache = new TopicCache({
    subscribe: (_topic, listener) => {
      listeners.push(listener);
      return () => {
        unsubscribed += 1;
      };
    },
  });
  const stop = cache.watch("projects", () => {});
  listeners[0](["x"]);
  stop();
  const stopAgain = cache.watch("projects", () => {});
  await flush();
  assert.equal(listeners.length, 1);
  assert.equal(unsubscribed, 0);
  assert.deepEqual(cache.get("projects"), ["x"]);
  stopAgain();
});
