import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { create } from "zustand";

import { registerViewer, type PanelViewer, type ViewerContext } from "../core/registry.ts";
import { createPanelSlice, type PanelSlice } from "../state/slice.ts";
import { matchOpenFiles } from "../viewers/kinds.ts";
import { openFilesPlace } from "./open-files-place.ts";

const ctx: ViewerContext = { projectId: "p", projectPath: "/work", sessionFiles: [] };

function stub(id: string, match: PanelViewer["match"]): PanelViewer {
  return {
    id,
    match,
    icon: () => null,
    title: () => id,
    View: () => null,
  };
}

describe("open files filter", { concurrency: 1 }, () => {
  test("filter text stays on the tab when switching away and collapsing the sidebar", async () => {
    const undo = [
      registerViewer(stub("files-filter-probe", matchOpenFiles)),
      registerViewer(stub("blank-filter-probe", (target) => (target.kind === "blank" ? 50 : 0))),
    ];
    try {
      const store = create<PanelSlice>()((set, get) => createPanelSlice(set, get));
      await store.getState().panelOpenTarget("s", { kind: "custom", type: "open-files" }, ctx);
      store.getState().panelPatchTabPayload("s", "custom:open-files", {
        path: "src/a.ts",
        line: 4,
        filter: "按钮",
      });
      store.getState().panelPatchTabPayload("s", "custom:open-files", { path: "src/b.ts" });
      await store.getState().panelOpenTarget("s", { kind: "blank" }, ctx);
      assert.notEqual(store.getState().panelBySession.s?.activeId, "custom:open-files");

      store.getState().panelHide("s");
      assert.equal(store.getState().panelBySession.s?.layout, "chat");
      store.getState().panelShow("s");
      assert.equal(store.getState().panelBySession.s?.layout, "split");

      await store.getState().panelOpenTarget("s", { kind: "custom", type: "open-files" }, ctx);
      const tab = store.getState().panelBySession.s?.tabs.find((item) => item.id === "custom:open-files");
      assert.equal(store.getState().panelBySession.s?.activeId, "custom:open-files");
      assert.deepEqual(openFilesPlace(tab?.payload), {
        path: "src/b.ts",
        line: 4,
        filter: "按钮",
      });
    } finally {
      for (const release of undo) release();
    }
  });
});