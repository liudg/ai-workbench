import assert from "node:assert/strict";
import { test } from "node:test";

import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import { diffMenuEntries } from "./diff-menu.ts";
import { DIFF_TOOLBAR_ICON_IDS } from "./toolbar-actions.ts";

test("diff overflow menu matches the desktop screenshot", () => {
  const disabled = diffMenuEntries({ enabled: false, reason: DESKTOP_ZH.diffNotGit });
  assert.deepEqual(
    disabled.map((entry) => entry.id),
    ["load-full", "render", "word", "hide-space", "hide-imports", "copy-apply"],
  );
  assert.deepEqual(
    disabled.filter((entry) => entry.kind === "check").map((entry) => entry.label),
    [
      DESKTOP_ZH.diffLoadFull,
      DESKTOP_ZH.diffRender,
      DESKTOP_ZH.diffWord,
      DESKTOP_ZH.diffHideSpace,
      DESKTOP_ZH.diffHideImports,
    ],
  );
  assert.equal(disabled.find((entry) => entry.id === "copy-apply")?.kind, "disabled");
  assert.equal(disabled.find((entry) => entry.id === "copy-apply")?.reason, DESKTOP_ZH.diffNotGit);

  const enabled = diffMenuEntries({ enabled: true, reason: "" });
  assert.equal(enabled.find((entry) => entry.id === "copy-apply")?.kind, "action");
});

test("diff toolbar icons follow the desktop button row", () => {
  assert.deepEqual(
    [...DIFF_TOOLBAR_ICON_IDS],
    ["options", "jump", "refresh", "wrap", "expand", "layout", "files"],
  );
});
