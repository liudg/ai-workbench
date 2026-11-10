import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

import type { TextSnippet } from "../../../shared/text-snippet.ts";
import type { Attachment } from "../../../types/index.ts";
import type { ComposerRun } from "./composer-run.ts";

const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
let server: ViteDevServer;
let runComposerSubmit: typeof import("./composer-run.ts").runComposerSubmit;

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  runComposerSubmit = (await server.ssrLoadModule("/src/features/chat/composer/composer-run.ts")).runComposerSubmit;
});

after(async () => {
  await server?.close();
});

const shot: Attachment = { path: "C:/tmp/shot.png", name: "shot.png" } as Attachment;
const quote = { id: "q1", quote: "第一段", path: "a.md", start: 1, end: 2 } as TextSnippet;

/** 先清空再发的那条路径：输入框、附件、引用都记在这里。 */
function liveRun(text: string, accepted: boolean) {
  const box = { value: text, focus: () => {} };
  const state = { text, files: [shot], snippets: [quote], sent: [] as string[] };
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const run = {
    host: {
      files: state.files,
      snippets: state.snippets,
      send: async (body: string) => {
        state.sent.push(body);
        queueMicrotask(settle);
        return accepted;
      },
      clearAttachments: () => (state.files = []),
      addAttachments: (files: Attachment[]) => (state.files = [...state.files, ...files]),
      clearTextSnippets: () => (state.snippets = []),
      restoreTextSnippets: (snippets: TextSnippet[]) => (state.snippets = [...snippets, ...state.snippets]),
    },
    flightKey: "s",
    text,
    caret: text.length,
    fileRefs: [],
    editingId: null,
    setText: (next: string) => {
      state.text = next;
      box.value = next;
    },
    setCaret: () => {},
    textareaRef: { current: box },
    view: { planOn: false, imagesOn: true, pendingId: null, pendingKind: null, composerLocked: false },
    caps: { supports_plan: true, supports_review: false },
    goalDraft: false,
    supportsGoals: false,
    submitFlight: { current: null },
    holdUntilAccepted: false,
  } as unknown as ComposerRun;
  return { run, box, state, settled };
}

test("a rejected send puts the text, images and quotes back", async () => {
  const { run, state, settled } = liveRun("接着上次的说", false);
  runComposerSubmit(run);
  assert.equal(state.text, "", "先清空");
  assert.deepEqual(state.files, []);
  assert.deepEqual(state.snippets, []);
  await settled;
  await Promise.resolve();
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0], /第一段/);
  assert.equal(state.text, "接着上次的说");
  assert.deepEqual(state.files, [shot]);
  assert.deepEqual(state.snippets, [quote]);
  assert.equal(run.submitFlight.current, null, "放回来之后还能再发");
});

test("a rejected send leaves newer typing alone", async () => {
  const { run, box, state, settled } = liveRun("接着上次的说", false);
  runComposerSubmit(run);
  box.value = "换个说法";
  state.text = "换个说法";
  await settled;
  await Promise.resolve();
  assert.equal(state.text, "换个说法");
});

test("an accepted send stays cleared", async () => {
  const { run, state, settled } = liveRun("接着上次的说", true);
  runComposerSubmit(run);
  await settled;
  await Promise.resolve();
  assert.equal(state.text, "");
  assert.deepEqual(state.files, []);
  assert.deepEqual(state.snippets, []);
});
