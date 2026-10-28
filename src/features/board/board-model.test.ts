import assert from "node:assert/strict";
import { test } from "node:test";

import type { Attention } from "../../shared/attention/attention.ts";
import { buildBoard, IDLE_LIMIT, type BoardTask } from "./board-model.ts";

const card = (id: string, attention: Partial<Attention> & Pick<Attention, "state">, archived = false): BoardTask => ({
  id,
  title: id,
  archivedAt: archived ? 1 : undefined,
  attention: { unread: false, updatedAt: 0, ...attention },
});

test("tasks land in orca's four columns, archived ones stay off", () => {
  const lanes = buildBoard([
    card("ask", { state: "needs-input", ask: "approval", updatedAt: 5 }),
    card("broke", { state: "failed", unread: true, updatedAt: 1 }),
    card("run", { state: "working" }),
    card("fresh", { state: "done", unread: true, updatedAt: 2 }),
    card("newer", { state: "done", unread: true, updatedAt: 3 }),
    card("seen", { state: "done" }),
    card("gone", { state: "needs-input" }, true),
  ]);
  assert.deepEqual(
    lanes.map((lane) => [lane.column, lane.cards.map((item) => item.id)]),
    [
      ["needs-you", ["ask", "broke"]],
      ["working", ["run"]],
      ["done", ["newer", "fresh"]],
      ["idle", ["seen"]],
    ],
  );
});

test("idle column is capped", () => {
  const many = Array.from({ length: IDLE_LIMIT + 3 }, (_, index) => card(`i${index}`, { state: "idle", updatedAt: index }));
  const idle = buildBoard(many)[3];
  assert.equal(idle.cards.length, IDLE_LIMIT);
  assert.equal(idle.hidden, 3);
  assert.equal(idle.cards[0].id, `i${IDLE_LIMIT + 2}`);
});
