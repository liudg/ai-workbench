import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent } from "../types/index.ts";
import { applyLiveEvent, mergeEvents, mergeOlderPage } from "./event-log.ts";

function ev(id: string, seq: number, text = id, ts = seq): SessionEvent {
  return { id, session_id: "s", seq, ts, kind: "user-message", text };
}

function textOf(event: SessionEvent): string {
  return event.kind === "user-message" ? event.text : event.id;
}

test("live events land in sequence order when they arrive out of order", () => {
  let log = applyLiveEvent([], ev("c", 3));
  log = applyLiveEvent(log, ev("a", 1));
  log = applyLiveEvent(log, ev("b", 2));
  assert.deepEqual(
    log.map((event) => event.id),
    ["a", "b", "c"],
  );

  const late = applyLiveEvent(applyLiveEvent(log, ev("e", 5)), ev("d", 4));
  assert.deepEqual(
    late.map((event) => event.seq),
    [1, 2, 3, 4, 5],
  );
});

test("a repeated id replaces the row and a repeated seq does not append", () => {
  const first = applyLiveEvent([], ev("a", 1, "one"));
  const updated = applyLiveEvent(applyLiveEvent(first, ev("b", 2)), ev("a", 1, "two", 9));
  assert.deepEqual(
    updated.map((event) => [event.id, textOf(event)]),
    [
      ["a", "two"],
      ["b", "b"],
    ],
  );

  const collided = applyLiveEvent(updated, ev("c", 1, "other"));
  assert.deepEqual(
    collided.map((event) => event.id),
    ["c", "b"],
  );
  assert.equal(applyLiveEvent(collided, ev("c", 1, "other")).length, collided.length);
});

test("an older page prepends without duplicating rows already in the log", () => {
  const current = [ev("c", 3, "local"), ev("d", 4, "tail")];
  const page = [ev("b", 2), ev("a", 1), ev("c", 3, "page"), ev("c", 3, "page-again")];
  const merged = mergeOlderPage(current, page);
  assert.deepEqual(
    merged.map((event) => `${event.id}:${textOf(event)}`),
    ["a:a", "b:b", "c:page-again", "d:tail"],
  );
});

test("an older page keeps a local event that sits in a sequence gap", () => {
  const current = [
    ev("a", 1, "local-a"),
    ev("stale", 2, "drop"),
    ev("gap", 3, "kept"),
    ev("tail", 6, "after"),
  ];
  const page = [ev("a", 1, "page-a"), ev("b", 2), ev("d", 4), ev("e", 5)];
  const merged = mergeOlderPage(current, page);
  assert.deepEqual(
    merged.map((event) => `${event.id}:${textOf(event)}`),
    ["a:page-a", "b:b", "gap:kept", "d:d", "e:e", "tail:after"],
  );
});

test("an empty older page does not wipe events that are already shown", () => {
  const current = [ev("b", 2), ev("a", 1)];
  assert.deepEqual(
    mergeOlderPage(current, []).map((event) => event.id),
    ["a", "b"],
  );
});

test("reconnect adopts the shifted snapshot and keeps events that arrived after it", () => {
  const local = [ev("a", 1, "local", 9), ev("late", 4, "after", 12), ev("gap", 3, "hole", 11)];
  const remote = [ev("o", 1, "older", 1), ev("a", 2, "shifted", 8)];
  const merged = mergeEvents(local, remote);
  assert.deepEqual(
    merged.map((event) => [event.id, event.seq, textOf(event)]),
    [
      ["o", 1, "older"],
      ["a", 2, "shifted"],
      ["gap", 3, "hole"],
      ["late", 4, "after"],
    ],
  );
});

test("reconnect keeps a newer local body when the seq did not move", () => {
  const local = [ev("a", 2, "streamed", 30)];
  const remote = [ev("b", 3, "next", 11), ev("a", 2, "snapshot", 10)];
  const merged = mergeEvents(local, remote);
  assert.deepEqual(
    merged.map((event) => [event.id, textOf(event)]),
    [
      ["a", "streamed"],
      ["b", "next"],
    ],
  );
  const snapshot = mergeEvents(undefined, remote).find((event) => event.id === "a");
  assert.equal(snapshot && textOf(snapshot), "snapshot");
});

test("the same text with a new id and seq stays a second row", () => {
  const log = applyLiveEvent(applyLiveEvent([], ev("u1", 1, "reply ok")), ev("u2", 2, "reply ok"));
  assert.deepEqual(
    log.map((event) => [event.id, textOf(event)]),
    [
      ["u1", "reply ok"],
      ["u2", "reply ok"],
    ],
  );
});
