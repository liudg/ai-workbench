import assert from "node:assert/strict";
import { test } from "node:test";

import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import { openWithActions } from "./open-with.ts";

test("open-with lists the default app and adds choose-app only when the system allows it", () => {
  assert.deepEqual(openWithActions(false), [{ id: "default", label: DESKTOP_ZH.openFileDefault }]);
  assert.deepEqual(openWithActions(true), [
    { id: "default", label: "用默认应用打开" },
    { id: "choose", label: "选择应用…" },
  ]);
  assert.equal(DESKTOP_ZH.openFile, "打开");
  assert.notEqual(DESKTOP_ZH.openFileMenu, DESKTOP_ZH.openWith);
});
