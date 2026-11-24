import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import { emptySandbox, type AgentCapabilities, type SessionEvent } from "../../../types/index.ts";
import { deriveComposerView, runComposerPrimary, type ComposerViewInput } from "./composer-view.ts";

const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
const dom = new Window({ url: "http://localhost/" });
const installed: PropertyKey[] = [];

function installGlobal(key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (descriptor && !descriptor.configurable && !descriptor.writable) return;
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  installed.push(key);
}

installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
installGlobal("window", dom);
installGlobal("document", dom.document);
installGlobal("HTMLElement", dom.HTMLElement);
installGlobal("Element", dom.Element);
installGlobal("Node", dom.Node);
installGlobal("navigator", dom.navigator);
installGlobal("MutationObserver", dom.MutationObserver);
installGlobal("ResizeObserver", dom.ResizeObserver);
installGlobal("getComputedStyle", dom.getComputedStyle.bind(dom));
installGlobal("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
installGlobal("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));

let server: ViteDevServer;
let ComposerBar: typeof import("./ComposerBar.tsx").ComposerBar;
let useComposerController: typeof import("./useComposerController.ts").useComposerController;

const caps = {
  supports_slash: true,
  supports_resume: true,
  supports_questions: true,
  supports_tuning: true,
  supports_skills: true,
  supports_images: true,
  supports_queue: true,
  supports_cancel: true,
  supports_plan: true,
  supports_review: true,
  changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
} satisfies AgentCapabilities;

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ComposerBar = (await server.ssrLoadModule("/src/features/chat/composer/ComposerBar.tsx")).ComposerBar;
  useComposerController = (
    await server.ssrLoadModule("/src/features/chat/composer/useComposerController.ts")
  ).useComposerController;
});

after(async () => {
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

function approval(): SessionEvent {
  return {
    id: "bash",
    session_id: "s",
    seq: 1,
    ts: 1,
    kind: "prompt",
    prompt_id: "bash",
    prompt_kind: "approval",
    question: "允许使用 Bash?",
    options: [],
    questions: [],
  };
}

function composerInput(patch: Partial<ComposerViewInput>): ComposerViewInput {
  return {
    status: "completed",
    events: [],
    caps,
    permissionMenu: null,
    sandbox: emptySandbox(),
    commands: [],
    skills: [],
    catalog: undefined,
    tuning: undefined,
    catalogNotice: null,
    text: "",
    caret: 0,
    editingId: null,
    fileCount: 0,
    snippetCount: 0,
    goalDraft: false,
    ...patch,
  };
}

function bar(input: { stopMode: boolean; sendDisabled: boolean; onSend: () => void }) {
  const ref = createRef<HTMLButtonElement>();
  return createElement(ComposerBar, {
    plusRef: ref as RefObject<HTMLButtonElement>,
    accessRef: ref as RefObject<HTMLButtonElement>,
    modelRef: ref as RefObject<HTMLButtonElement>,
    menu: null,
    imagesOn: false,
    composerLocked: false,
    sandbox: null,
    permissionMenu: null,
    planIndicator: false,
    goalChip: false,
    showModel: false,
    modelReady: false,
    modelButton: "",
    editing: false,
    onToggleMenu: () => undefined,
    onPickFiles: () => undefined,
    onDismissPlan: () => undefined,
    onDismissGoal: () => undefined,
    onCancelEdit: () => undefined,
    ...input,
  });
}

test("pending approval shows 停止 and clicking it interrupts; a finished turn shows 发送", async () => {
  const pressed: string[] = [];
  const running = deriveComposerView(composerInput({ status: "running", events: [approval()] }));
  assert.equal(running.stopMode, true);
  assert.equal(running.sendDisabled, false);

  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(
      bar({
        stopMode: running.stopMode,
        sendDisabled: running.sendDisabled,
        onSend: () =>
          runComposerPrimary(running.stopMode, {
            interrupt: () => pressed.push("interrupt"),
            submit: () => pressed.push("submit"),
          }),
      }),
    );
  });

  const stop = dom.document.querySelector('button[aria-label="停止"]');
  assert.ok(stop instanceof dom.HTMLButtonElement);
  assert.equal(stop.disabled, false);
  stop.click();
  assert.deepEqual(pressed, ["interrupt"]);

  const finished = deriveComposerView(
    composerInput({
      status: "completed",
      events: [
        approval(),
        { id: "done", session_id: "s", seq: 2, ts: 2, kind: "status-changed", status: "completed" },
      ],
    }),
  );
  assert.equal(finished.stopMode, false);
  await act(async () => {
    root.render(
      bar({
        stopMode: finished.stopMode,
        sendDisabled: finished.sendDisabled,
        onSend: () =>
          runComposerPrimary(finished.stopMode, {
            interrupt: () => pressed.push("interrupt"),
            submit: () => pressed.push("submit"),
          }),
      }),
    );
  });
  assert.equal(dom.document.querySelector('button[aria-label="停止"]'), null);
  const send = dom.document.querySelector('button[aria-label="发送"]');
  assert.ok(send instanceof dom.HTMLButtonElement);
  assert.equal(send.disabled, true);
  send.click();
  assert.deepEqual(pressed, ["interrupt"]);

  const cancelOnly = deriveComposerView(
    composerInput({
      status: "running",
      caps: { ...caps, supports_queue: false, supports_cancel: true },
      events: [approval()],
    }),
  );
  assert.equal(cancelOnly.stopMode, true);
  assert.equal(cancelOnly.queueOn, false);
  await act(async () => {
    root.render(
      bar({
        stopMode: cancelOnly.stopMode,
        sendDisabled: cancelOnly.sendDisabled,
        onSend: () =>
          runComposerPrimary(cancelOnly.stopMode, {
            interrupt: () => pressed.push("interrupt"),
            submit: () => pressed.push("submit"),
          }),
      }),
    );
  });
  const cancelStop = dom.document.querySelector('button[aria-label="停止"]');
  assert.ok(cancelStop instanceof dom.HTMLButtonElement);
  assert.equal(cancelStop.disabled, false);
  cancelStop.click();
  assert.deepEqual(pressed, ["interrupt", "interrupt"]);

  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test("useComposerController syncs externally cleared initialFileRefs without clobbering typing and auto-clears stale editingId", async () => {
  const hostEl = dom.document.createElement("div");
  dom.document.body.appendChild(hostEl);
  const root: Root = createRoot(hostEl as unknown as HTMLElement);

  let latestCtrl: ReturnType<typeof useComposerController> | null = null;
  let draftText = "请检查 @foo.ts ";
  let draftRefs = [{ label: "@foo.ts", path: "src/foo.ts" }];
  let queue = [{ id: "q-1", text: "排队中的追问", images: [] as string[] }];

  const session = {
    id: "sess-ctrl-1",
    native_id: "n-1",
    project_id: "p-1",
    agent: "codex-cli" as const,
    title: "测试",
    status: "running" as const,
    created_at: 1,
    updated_at: 1,
  };

  function Harness({ tick: _tick }: { tick: number }) {
    const composerHost = {
      draft: false,
      inputLocked: false,
      initialText: draftText,
      initialFileRefs: draftRefs,
      catalog: undefined,
      catalogNotice: null,
      profile: { kind: "codex-cli" as const, capabilities: caps, commands: [] },
      tuning: undefined,
      sandbox: emptySandbox(),
      permissionMenu: null,
      projectPath: "",
      files: [],
      snippets: [],
      queue,
      followUpQueueMode: "queue" as const,
      git: null,
      workContext: null,
      worktree: null,
      agentChoice: null,
      rememberText: (t: string) => {
        draftText = t;
      },
      rememberFileRefs: (refs: typeof draftRefs) => {
        draftRefs = refs;
      },
      send: async () => true,
      setCollaborationMode: async () => {},
      startReview: async () => {},
      reviewTargets: async () => ({ branches: [], commits: [], labels: {} as never }),
      answerPrompt: async () => true,
      setSandbox: () => {},
      setTuning: () => {},
      addAttachments: () => {},
      removeAttachment: () => {},
      clearAttachments: () => {},
      replaceAttachments: () => {},
      clearTextSnippets: () => {},
      restoreTextSnippets: () => {},
      removeTextSnippet: () => {},
      updateQueued: async () => {},
      removeQueued: async () => {},
      steerQueued: async () => {},
      flushQueued: async () => {},
      setFollowUpQueueMode: () => {},
      interrupt: () => {},
      setGoal: async () => {},
      clearGoal: async () => {},
      setGoalStatus: async () => {},
      publishGoal: async () => {},
      filterPaths: async () => ({ paths: [], truncated: false, cancelled: false, ready: true }),
      reportError: () => {},
    };
    latestCtrl = useComposerController(composerHost, session, []);
    return createElement("textarea", { ref: latestCtrl.textareaRef });
  }

  try {
    await act(async () => {
      root.render(createElement(Harness, { tick: 0 }));
    });
    assert.equal(latestCtrl!.tokens.some((tok) => tok.kind === "file" && tok.path === "src/foo.ts"), true);

    // Normal typing preserves @foo.ts fileRef
    await act(async () => {
      latestCtrl!.setText("请检查 @foo.ts 的边界条件");
      root.render(createElement(Harness, { tick: 1 }));
    });
    assert.equal(latestCtrl!.tokens.some((tok) => tok.kind === "file" && tok.path === "src/foo.ts"), true);

    // External draft replacement (e.g. restoreRewoundDraft / setDraftText) clears initialFileRefs to [] even when @foo.ts text remains
    draftText = "回退草稿里的字面量 @foo.ts";
    draftRefs = [];
    await act(async () => {
      root.render(createElement(Harness, { tick: 2 }));
    });
    assert.equal(latestCtrl!.text, "回退草稿里的字面量 @foo.ts");
    assert.equal(
      latestCtrl!.tokens.some((tok) => tok.kind === "file"),
      false,
      "externally cleared initialFileRefs must clear stale internal fileRefs",
    );

    // Begin editing queued turn q-1, then dequeue q-1 externally -> editingId auto-clears to null!
    await act(async () => {
      latestCtrl!.beginEdit(queue[0]!);
    });
    assert.equal(latestCtrl!.editingId, "q-1");

    queue = [];
    await act(async () => {
      root.render(createElement(Harness, { tick: 3 }));
    });
    assert.equal(latestCtrl!.editingId, null, "editingId must clear when queued item disappears");
  } finally {
    await act(async () => {
      root.unmount();
    });
    hostEl.remove();
  }
});
