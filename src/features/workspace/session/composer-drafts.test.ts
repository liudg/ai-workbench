import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { createServer } from "vite";

test("restoreRewoundDraft loads session draft and restores rewound text and file attachments", async () => {
  const dom = new Window({ url: "http://localhost/" });
  const prevWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: dom });
  const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
  const server = await createServer({
    root: rootDir,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "error",
  });
  const { daemon } = (await server.ssrLoadModule("/src/lib/daemon/index.ts")) as typeof import("../../../lib/daemon/index.ts");
  const originalCall = daemon.call;
  try {
    daemon.call = (async (method: string) => {
      if (method === "drafts.get") {
        return { text: "old", files: [], snippets: [{ id: "snip-1", quote: "keep-snippet" }] };
      }
      if (method === "drafts.set") return null;
      throw new Error(`Unexpected call: ${method}`);
    }) as typeof daemon.call;

    const drafts = (await server.ssrLoadModule(
      "/src/features/workspace/session/composer-drafts.ts",
    )) as typeof import("./composer-drafts.ts");

    await drafts.restoreRewoundDraft("sess-rewind-1", {
      text: "撤回的消息正文",
      files: [
        { path: "C:\\img\\a.png", name: "a.png" },
        { path: "C:\\doc\\b.pdf", name: "b.pdf" },
      ],
    });

    const after = drafts.readDraft("sess-rewind-1");
    assert.equal(after.text, "撤回的消息正文");
    assert.deepEqual(after.files, [
      { path: "C:\\img\\a.png", name: "a.png" },
      { path: "C:\\doc\\b.pdf", name: "b.pdf" },
    ]);
    assert.deepEqual(after.fileRefs, []);
    assert.deepEqual(after.snippets, []);

    // setDraftText overwrites text and clears stale fileRefs & snippets from the replaced draft
    drafts.patchDraft("sess-overwrite-1", {
      text: "old draft @foo.ts",
      fileRefs: [{ label: "@foo.ts", path: "src/foo.ts" }],
      files: [],
      snippets: [{ id: "snip-old", path: "src/foo.ts", start: 1, end: 2, body: "x", quote: "x" }],
    });
    await drafts.setDraftText("sess-overwrite-1", "外部新提示词");
    const overwritten = drafts.readDraft("sess-overwrite-1");
    assert.equal(overwritten.text, "外部新提示词");
    assert.deepEqual(overwritten.fileRefs, []);
    assert.deepEqual(overwritten.snippets, []);
  } finally {
    daemon.call = originalCall;
    daemon.stop();
    await server.close();
    await dom.close();
    if (prevWindow) Object.defineProperty(globalThis, "window", prevWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
