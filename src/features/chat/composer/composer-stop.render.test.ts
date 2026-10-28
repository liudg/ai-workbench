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
});
