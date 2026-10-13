import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { create } from "zustand";

import { createPanelSlice, type PanelSlice } from "../state/slice.ts";
import * as browser from "../browser/browser.ts";
import { matchDiff, matchHtml, matchImage, matchMarkdown, matchText } from "../viewers/kinds.ts";
import { targetFromHref } from "./open-target.ts";
import {
  registerViewer,
  resolveViewer,
  type OpenTarget,
  type PanelViewer,
  type ViewerContext,
} from "./registry.ts";

const ctx: ViewerContext = {
  projectId: "project-1",
  projectPath: "C:/work/demo",
  sessionFiles: [],
};

function testStore() {
  return create<PanelSlice>()((set, get) => createPanelSlice(set, get));
}

function stub(id: string, match: PanelViewer["match"], load?: PanelViewer["load"]): PanelViewer {
  return {
    id,
    match,
    icon: () => null,
    title: (payload: { title?: string }) => payload?.title ?? id,
    load,
    View: () => null,
  };
}

describe("panel viewers", { concurrency: 1 }, () => {
  test("a fake viewer registers and opens without editing core", async () => {
    const seen: OpenTarget[] = [];
    const undo = registerViewer({
      id: "probe",
      match: (target) => (target.kind === "custom" && target.type === "probe" ? 50 : 0),
      icon: () => null,
      title: (payload: { title?: string }) => payload.title ?? "",
      menu: [{ id: "ping", label: "Ping" }],
      async load(target) {
        seen.push(target);
        return { title: "探针", marker: 1 };
      },
      View: () => null,
    });
    try {
      assert.equal(resolveViewer({ kind: "custom", type: "probe" })?.id, "probe");
      assert.equal(resolveViewer({ kind: "custom", type: "probe" })?.menu?.[0]?.label, "Ping");
      const store = testStore();
      await store.getState().panelOpenTarget("session-a", { kind: "custom", type: "probe" }, ctx);
      const tab = store.getState().panelBySession["session-a"]?.tabs[0];
      assert.equal(tab?.viewerId, "probe");
      assert.equal(tab?.status, "ready");
      assert.equal((tab?.payload as { marker?: number }).marker, 1);
      assert.equal(seen.length, 1);
      assert.equal(store.getState().panelBySession["session-a"]?.tabs[0]?.id, "custom:probe");
    } finally {
      undo();
    }
    assert.equal(resolveViewer({ kind: "custom", type: "probe" }), null);
  });

  test("builtin matchers claim html, markdown, text with a line, and diff", () => {
    const undo = [
      registerViewer(stub("html", matchHtml)),
      registerViewer(stub("markdown", matchMarkdown)),
      registerViewer(stub("image", matchImage)),
      registerViewer(stub("text", matchText)),
      registerViewer(stub("diff", matchDiff)),
    ];
    try {
      assert.equal(resolveViewer({ kind: "file", path: "C:/work/demo/index.html", line: null })?.id, "html");
      assert.equal(resolveViewer({ kind: "file", path: "C:/work/demo/index.html", line: 4 })?.id, "text");
      assert.equal(resolveViewer({ kind: "file", path: "C:/work/demo/notes.md", line: null })?.id, "markdown");
      assert.equal(resolveViewer({ kind: "file", path: "C:/work/demo/src/app.ts", line: 2 })?.id, "text");
      assert.equal(resolveViewer({ kind: "file", path: "C:/work/demo/src/app.ts", line: null })?.id, "text");
      assert.equal(resolveViewer({ kind: "file", path: "C:/work/demo/available-live.png", line: null })?.id, "image");
      assert.equal(resolveViewer({ kind: "file", path: "C:/work/demo/available-live.png", line: 3 })?.id, "image");
      assert.equal(resolveViewer({ kind: "url", url: "https://example.com" })?.id, "html");
      assert.equal(resolveViewer({ kind: "blank" })?.id, "html");
      assert.equal(resolveViewer({ kind: "blocked", href: "../x", line: null, message: "no" })?.id, "text");
      assert.equal(
        resolveViewer({ kind: "diff", id: "d", title: "变更", files: [] })?.id,
        "diff",
      );
      assert.equal(
        resolveViewer({ kind: "file", path: "C:/work/demo/index.html", line: null, viewerId: "markdown" })?.id,
        "markdown",
      );
    } finally {
      for (const release of undo) release();
    }
  });

  test("opening one session leaves the other session's tabs and browser history", async () => {
    assert.equal("rememberHistory" in browser, false);
    assert.equal("clearBrowserHistories" in browser, false);
    const undo = [
      registerViewer(
        stub("text", matchText, async (target) => ({
          title: "app.ts",
          text: "one\ntwo",
          truncated: false,
          line: target.kind === "file" ? target.line : null,
        })),
      ),
      registerViewer(
        stub("probe", (target) => (target.kind === "custom" && target.type === "probe" ? 40 : 0), async () => ({
          title: "其它",
        })),
      ),
    ];
    try {
      const store = testStore();
      await store.getState().panelOpenHref("left", "src/app.ts#L2", undefined, ctx);
      const left = store.getState().panelBySession.left;
      assert.equal(left?.tabs[0]?.viewerId, "text");
      assert.equal(left?.tabs[0]?.status, "ready");
      assert.equal((left?.tabs[0]?.payload as { line?: number }).line, 2);
      const tabId = left?.tabs[0]?.id ?? "";
      store.getState().panelRememberHistory("left", tabId, {
        entries: [{ address: "C:/work/demo/src/app.ts", target: "http://asset.localhost/app.ts" }],
        index: 0,
      });
      await store.getState().panelOpenTarget("right", { kind: "custom", type: "probe" }, ctx);
      store.getState().panelCloseTab("right", "custom:probe");
      const after = store.getState().panelBySession;
      assert.equal(after.left?.tabs.length, 1);
      assert.equal(after.left?.tabs[0]?.viewerId, "text");
      assert.equal(after.left?.histories[tabId]?.entries[0]?.address, "C:/work/demo/src/app.ts");
      assert.equal(after.right?.tabs.length, 0);
      assert.deepEqual(after.right?.histories, {});
    } finally {
      for (const release of undo) release();
    }
  });

  test("the side panel stays closed until the marker opens a new tab", async () => {
    const undo = registerViewer(stub("html", (target) => (target.kind === "blank" ? 100 : 0)));
    try {
      const store = testStore();
      assert.equal(store.getState().panelBySession.s, undefined);
      store.getState().panelShow("s");
      const opened = store.getState().panelBySession.s;
      assert.equal(opened?.layout, "split");
      assert.equal(opened?.tabs.length, 1);
      assert.equal(opened?.tabs[0]?.viewerId, "html");
      store.getState().panelOpenTarget("s", { kind: "blank" }, ctx);
      assert.equal(store.getState().panelBySession.s?.tabs.length, 2);
      store.getState().panelHide("s");
      assert.equal(store.getState().panelBySession.s?.layout, "chat");
      assert.equal(store.getState().panelBySession.s?.tabs.length, 2);
      store.getState().panelShow("s");
      assert.equal(store.getState().panelBySession.s?.layout, "split");
      assert.equal(store.getState().panelBySession.s?.tabs.length, 2);
      store.getState().panelToggleFull("s");
      assert.equal(store.getState().panelBySession.s?.layout, "full");
      store.getState().panelToggleFull("s");
      assert.equal(store.getState().panelBySession.s?.layout, "split");
      for (const tab of store.getState().panelBySession.s?.tabs ?? []) {
        store.getState().panelCloseTab("s", tab.id);
      }
      assert.equal(store.getState().panelBySession.s?.layout, "chat");
      assert.equal(store.getState().panelBySession.s?.tabs.length, 0);
    } finally {
      undo();
    }
  });

  test("dragged column widths stay in the panel store and do not create a session panel", () => {
    const store = testStore();
    store.getState().panelSetPreviewWidth("session-a", 640.4);
    store.getState().panelSetDiffFilesWidth("session-a", 280);
    assert.equal(store.getState().previewWidthBySession["session-a"], 640);
    assert.equal(store.getState().diffFilesWidthBySession["session-a"], 280);
    assert.equal(store.getState().panelBySession["session-a"], undefined);
    store.getState().panelSetPreviewWidth("session-a", 640);
    assert.equal(store.getState().previewWidthBySession["session-a"], 640);
  });

  test("hrefs become urls, files inside or outside the project, or unreadable targets", () => {
    assert.deepEqual(targetFromHref("C:/work/demo", "https://example.com/a"), {
      kind: "url",
      url: "https://example.com/a",
    });
    assert.deepEqual(targetFromHref("C:/work/demo", "src/app.ts#L4"), {
      kind: "file",
      path: "C:/work/demo/src/app.ts",
      line: 4,
    });
    assert.deepEqual(targetFromHref("C:/work/demo", "../secret.txt"), {
      kind: "file",
      path: "C:/work/secret.txt",
      line: null,
    });
    assert.deepEqual(targetFromHref("C:/work/demo", "D:/other/notes.md"), {
      kind: "file",
      path: "D:/other/notes.md",
      line: null,
    });
    const blocked = targetFromHref("", "src/app.ts");
    assert.equal(blocked.kind, "blocked");
    if (blocked.kind === "blocked") {
      assert.equal(blocked.message, "没有项目目录，无法解析相对路径");
      assert.equal(blocked.message.includes("只能预览当前项目"), false);
    }
  });
});
