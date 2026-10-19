import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { create } from "zustand";

import { registerViewer, type PanelViewer, type ViewerContext } from "../core/registry.ts";
import { createPanelSlice, type PanelSlice } from "../state/slice.ts";
import { matchHtml, matchMarkdown, matchOpenFiles, matchText } from "../viewers/kinds.ts";
import { openFilesPlace } from "./open-files-place.ts";

const ctx: ViewerContext = { projectId: "p", projectPath: "C:/work/demo", sessionFiles: [] };

function stub(id: string, match: PanelViewer["match"], load?: PanelViewer["load"]): PanelViewer {
  return { id, match, icon: () => null, title: () => id, load, View: () => null };
}

describe("shared file preview", { concurrency: 1 }, () => {
  test("a chat file and the files module share one open-files tab", async () => {
    let markdownLoads = 0;
    const undo = [
      registerViewer(
        stub("markdown", matchMarkdown, async () => {
          markdownLoads += 1;
          return { title: "readme.md", text: "# hi" };
        }),
      ),
      registerViewer(stub("text", matchText, async () => ({ title: "app.ts", text: "one" }))),
      registerViewer(stub("files", matchOpenFiles)),
    ];
    try {
      const store = create<PanelSlice>()((set, get) => createPanelSlice(set, get));
      await store.getState().panelOpenHref("s", "docs/readme.md", undefined, ctx);
      await store.getState().panelOpenHref("s", "src/app.ts#L3", undefined, ctx);
      const session = store.getState().panelBySession.s;
      assert.equal(session?.tabs.length, 1);
      assert.equal(session?.tabs[0]?.id, "custom:open-files");
      assert.equal(session?.tabs[0]?.viewerId, "files");
      const place = openFilesPlace(session?.tabs[0]?.payload);
      assert.deepEqual(
        place.tabs.map((tab) => tab.path),
        ["docs/readme.md", "src/app.ts"],
      );
      assert.equal(place.path, "src/app.ts");
      assert.equal(place.line, 3);
      assert.equal(markdownLoads, 0);

      store.getState().panelToggleFilesSidebar("s");
      assert.equal(store.getState().panelBySession.s?.filesSidebarOpen, false);
      await store.getState().panelOpenHref("s", "docs/readme.md", undefined, ctx);
      assert.equal(store.getState().panelBySession.s?.filesSidebarOpen, false);

      store.getState().panelOpenFiles("s");
      assert.equal(store.getState().panelBySession.s?.activeId, "custom:open-files");
      assert.equal(store.getState().panelBySession.s?.filesSidebarOpen, true);
      assert.equal(store.getState().panelBySession.s?.tabs.length, 1);
      assert.equal(openFilesPlace(store.getState().panelBySession.s?.tabs[0]?.payload).path, "docs/readme.md");
    } finally {
      for (const release of undo) release();
    }
  });

  test("a line ref from the session keeps a closed file tree closed", async () => {
  let markdownLoads = 0;
  const undo = [
    registerViewer(
      stub("markdown", matchMarkdown, async () => {
        markdownLoads += 1;
        return { title: "note.md", text: "hi" };
      }),
    ),
    registerViewer(stub("files", matchOpenFiles)),
  ];
  try {
    const store = create<PanelSlice>()((set, get) => createPanelSlice(set, get));
    await store.getState().panelOpenHref("s", "README.md", undefined, ctx);
    store.getState().panelToggleFilesSidebar("s");
    assert.equal(store.getState().panelBySession.s?.filesSidebarOpen, false);
    await store.getState().panelOpenHref("s", "docs/note.md", 1, ctx);
    const session = store.getState().panelBySession.s;
    assert.equal(session?.filesSidebarOpen, false);
    assert.equal(session?.tabs.length, 1);
    assert.equal(session?.tabs[0]?.id, "custom:open-files");
    assert.equal(session?.tabs[0]?.viewerId, "files");
    const place = openFilesPlace(session?.tabs[0]?.payload);
    assert.equal(place.path, "docs/note.md");
    assert.equal(place.line, 1);
    assert.equal(markdownLoads, 0);
  } finally {
    for (const release of undo) release();
  }
});

test("local html without a line opens in the browser", async () => {
  let htmlLoads = 0;
  const undo = [
    registerViewer(
      stub("html", matchHtml, async (target) => {
        htmlLoads += 1;
        return {
          title: "snake.html",
          path: target.kind === "file" ? target.path : "",
          text: "<p>snake</p>",
        };
      }),
    ),
    registerViewer(stub("text", matchText, async () => ({ title: "app.ts", text: "one" }))),
    registerViewer(stub("files", matchOpenFiles)),
  ];
  try {
    const store = create<PanelSlice>()((set, get) => createPanelSlice(set, get));
    await store
      .getState()
      .panelOpenHref(
        "s",
        "</C:/Users/admin/Documents/AI Workbench/2026-10-19/h5-3/snake.html>",
        undefined,
        ctx,
      );
    const session = store.getState().panelBySession.s;
    assert.equal(session?.tabs.length, 1);
    assert.equal(session?.tabs[0]?.viewerId, "html");
    assert.equal(
      session?.tabs[0]?.id,
      "doc:c:/users/admin/documents/ai workbench/2026-10-19/h5-3/snake.html",
    );
    assert.equal(
      (session?.tabs[0]?.payload as { path?: string }).path,
      "C:/Users/admin/Documents/AI Workbench/2026-10-19/h5-3/snake.html",
    );
    assert.equal(htmlLoads, 1);

    await store.getState().panelOpenHref("s", "src/app.ts", undefined, ctx);
    const files = store.getState().panelBySession.s;
    assert.equal(files?.tabs.length, 2);
    assert.equal(files?.activeId, "custom:open-files");
    assert.equal(openFilesPlace(files?.tabs.find((tab) => tab.id === "custom:open-files")?.payload).path, "src/app.ts");

    await store.getState().panelOpenHref("s", "notes.htm#L3", undefined, ctx);
    const lined = store.getState().panelBySession.s;
    assert.equal(lined?.activeId, "custom:open-files");
    const place = openFilesPlace(lined?.tabs.find((tab) => tab.id === "custom:open-files")?.payload);
    assert.equal(place.path, "notes.htm");
    assert.equal(place.line, 3);
    assert.equal(htmlLoads, 1);

    await store.getState().panelOpenHref("s", "index.html", undefined, ctx);
    const page = store.getState().panelBySession.s?.tabs.find((tab) => tab.viewerId === "html" && tab.id.includes("index.html"));
    assert.equal((page?.payload as { path?: string }).path, "C:/work/demo/index.html");
    assert.equal(htmlLoads, 2);
  } finally {
    for (const release of undo) release();
  }
});

test("a web link stays out of the file preview", async () => {
    const undo = registerViewer(stub("page", (target) => (target.kind === "url" ? 100 : 0)));
    try {
      const store = create<PanelSlice>()((set, get) => createPanelSlice(set, get));
      await store.getState().panelOpenHref("s", "https://example.com/a", undefined, ctx);
      assert.equal(store.getState().panelBySession.s?.tabs[0]?.id, "web:https://example.com/a");
      assert.equal(store.getState().panelBySession.s?.tabs[0]?.viewerId, "page");
    } finally {
      undo();
    }
  });
});
