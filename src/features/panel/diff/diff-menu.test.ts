import assert from "node:assert/strict";
import { test } from "node:test";

import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import { diffMenuEntries } from "./diff-menu.ts";

test("diff menu lists the filmed actions and disables git apply", () => {
  const entries = diffMenuEntries();
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [
      "refresh",
      "wrap",
      "unified",
      "expand",
      "sep",
      "load-full",
      "render",
      "word",
      "hide-space",
      "hide-imports",
      "copy-apply",
    ],
  );
  assert.deepEqual(
    entries.filter((entry) => entry.kind === "check").map((entry) => entry.label),
    [DESKTOP_ZH.diffLoadFull, DESKTOP_ZH.diffRender, DESKTOP_ZH.diffWord],
  );
  assert.equal(entries.find((entry) => entry.id === "copy-apply")?.kind, "disabled");
  assert.equal(entries.find((entry) => entry.id === "hide-imports")?.label, DESKTOP_ZH.diffHideImports);
  assert.equal(entries.find((entry) => entry.id === "sep")?.kind, "separator");
});
