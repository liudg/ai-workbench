import assert from "node:assert/strict";
import { test } from "node:test";
import { blankSession, placeTab, selectTab, dropTab } from "../../panel/state/panel-session.ts";
import { recentSideTab } from "./selection.ts";

test("content follows the most recently selected chat across other tabs and closes", () => {
  let panel = blankSession();
  for (const id of ["a", "b", "c"]) panel = placeTab(panel, { id, viewerId: "side-chat", status: "ready", payload: {} }, false, true);
  assert.equal(recentSideTab(panel)?.id, "c");
  panel = selectTab(panel, "a");
  panel = placeTab(panel, { id: "file", viewerId: "text", status: "ready", payload: {} }, false, true);
  assert.equal(recentSideTab(panel)?.id, "a");
  panel = dropTab(panel, "a");
  assert.equal(recentSideTab(panel)?.id, "c");
  panel = dropTab(dropTab(panel, "b"), "c");
  assert.equal(recentSideTab(panel), undefined);
});

test("a pending first chat is reused while failed chats are skipped", () => {
  let panel = blankSession();
  panel = placeTab(panel, { id: "pending", viewerId: "side-chat", status: "loading", payload: {} }, false, true);
  panel = placeTab(panel, { id: "failed", viewerId: "side-chat", status: "error", payload: {} }, false, true);
  assert.equal(recentSideTab(panel)?.id, "pending");
});
