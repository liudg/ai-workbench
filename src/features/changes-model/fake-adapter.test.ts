import assert from "node:assert/strict";
import { test } from "node:test";

import { showsFileChanges, showsGitScopes, showsTurnScope } from "./capabilities.ts";
import { sessionChanges, turnChanges } from "./diff-parse.ts";
import { FAKE_CAPABILITIES, FAKE_FILE, FAKE_TURN_ID, fakeAdapterEvents } from "./fake-adapter.fixture.ts";
import { diffScopeMenu, filesForScope } from "../panel/diff/scope.ts";

test("a non-native adapter's normalized events fill the change card, session files, and previous turn", () => {
  const events = fakeAdapterEvents();
  const card = turnChanges(events);
  assert.equal(card?.id, FAKE_TURN_ID);
  assert.equal(card?.added, 2);
  assert.equal(card?.removed, 1);
  assert.deepEqual(card?.files.map((file) => file.path), [FAKE_FILE.path]);

  const sidebar = sessionChanges(events);
  assert.equal(sidebar.length, 1);
  assert.equal(sidebar[0]?.path, FAKE_FILE.path);

  const menu = diffScopeMenu(
    [{ id: "turn", label: "上一轮", source: "turn" }],
    FAKE_CAPABILITIES,
  );
  assert.deepEqual(
    menu.map((item) => [item.label, item.submenu]),
    [["上一轮", false]],
  );
  const shown = filesForScope(menu[0], card?.files ?? [], null);
  assert.equal(shown[0]?.path, FAKE_FILE.path);
  assert.equal(showsFileChanges(FAKE_CAPABILITIES), true);
  assert.equal(showsTurnScope(FAKE_CAPABILITIES), true);
  assert.equal(showsGitScopes(FAKE_CAPABILITIES), false);
});
