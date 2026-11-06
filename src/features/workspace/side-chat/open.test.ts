import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";
import { Window } from "happy-dom";

test("new tabs are independent; queued content reuses the last chat without sending, and closing during creation cleans up", async () => {
  const browser = new Window();
  const oldWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { value: browser, configurable: true, writable: true });
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { daemon } = await server.ssrLoadModule("/src/lib/daemon/index.ts");
    const calls: { method: string; params: any }[] = [];
    let count = 0;
    let delayed = false;
    let resolveOpen: ((value: unknown) => void) | undefined;
    daemon.call = async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "tasks.openSide") {
        if (delayed) return new Promise((resolve) => { resolveOpen = resolve; });
        return { id: `side-${++count}` };
      }
      if (method === "drafts.get") return { text: "existing", files: [], snippets: [] };
      return null;
    };
    const open = await server.ssrLoadModule("/src/features/workspace/side-chat/open.ts");
    const { usePanelStore } = await server.ssrLoadModule("/src/features/panel/state/store.ts");
    const { registerViewer } = await server.ssrLoadModule("/src/features/panel/core/registry.ts");
    const { readDraft } = await server.ssrLoadModule("/src/features/workspace/session/composer-drafts.ts");
    registerViewer({ id: "side-chat", match: () => 100, title: (p: any) => p.title,
      icon: () => null, View: () => null, load: (target: any) => open.loadSideChat(target.data), dispose: open.disposeSideChat });
    const state = usePanelStore.getState();
    const ctx = { projectId: "", projectPath: "", sessionFiles: [] };
    await state.panelOpenTarget("main", open.sideChatTarget("task"), ctx);
    await state.panelOpenTarget("main", open.sideChatTarget("task"), ctx);
    const tabs = usePanelStore.getState().panelBySession.main.tabs;
    assert.equal(tabs.length, 2);
    assert.notEqual(tabs[0].id, tabs[1].id);
    state.panelSelectTab("main", tabs[0].id);
    await open.askInSideChat("main", "task", { id: "q", text: "queued", images: ["C:/image.png"] });
    assert.equal(count, 2);
    assert.equal(readDraft("side-1").text, "existing\nqueued");
    assert.equal(readDraft("side-1").files[0].path, "C:/image.png");
    assert.equal(calls.filter((call) => call.method === "sessions.send").length, 0);
    state.panelCloseTab("main", tabs[0].id);
    assert.equal(usePanelStore.getState().panelBySession.main.tabs.length, 1);
    assert.deepEqual(calls.filter((call) => call.method === "tasks.closeSide").map((call) => call.params.sessionId), ["side-1"]);
    await open.askInSideChat("new-main", "task2", { id: "q2", text: "first" });
    assert.equal(count, 3);
    assert.equal(readDraft("side-3").text, "existing\nfirst");
    delayed = true;
    const pending = state.panelOpenTarget("main", open.sideChatTarget("task"), ctx);
    state.panelCloseTab("main", usePanelStore.getState().panelBySession.main.activeId);
    resolveOpen!({ id: "late-side" });
    await pending;
    assert.ok(calls.some((call) => call.method === "tasks.closeSide" && call.params.sessionId === "late-side"));
  } finally {
    await server.close();
    await browser.happyDOM.close();
    Object.defineProperty(globalThis, "window", { value: oldWindow, configurable: true, writable: true });
  }
});
