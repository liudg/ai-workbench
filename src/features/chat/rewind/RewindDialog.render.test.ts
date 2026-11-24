import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";

import type { RewindPreview, RewindResult } from "../../tasks/index.ts";
import type { AgentCapabilities, Session, SessionEvent } from "../../../types/index.ts";

const dom = new Window({ url: "http://localhost/" });
const globals = {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Element: dom.Element,
  Node: dom.Node,
  NodeFilter: dom.NodeFilter,
  SVGElement: dom.SVGElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
};
const descriptors = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

let server: ViteDevServer;
let RewindDialog: typeof import("./RewindDialog.tsx").RewindDialog;
let UserBubble: typeof import("../events/UserBubble.tsx").UserBubble;
let ChatHostProvider: typeof import("../host.tsx").ChatHostProvider;
let MessageMenuProvider: typeof import("../message-menu.tsx").MessageMenuProvider;

before(async () => {
  const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
  server = await createServer({
    root: rootDir,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "error",
  });
  RewindDialog = (await server.ssrLoadModule("/src/features/chat/rewind/RewindDialog.tsx")).RewindDialog;
  UserBubble = (await server.ssrLoadModule("/src/features/chat/events/UserBubble.tsx")).UserBubble;
  ChatHostProvider = (await server.ssrLoadModule("/src/features/chat/host.tsx")).ChatHostProvider;
  MessageMenuProvider = (await server.ssrLoadModule("/src/features/chat/message-menu.tsx")).MessageMenuProvider;
});

after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await server?.close();
  await dom.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const baseCaps: AgentCapabilities = {
  supports_slash: true,
  supports_resume: true,
  supports_questions: true,
  supports_tuning: true,
  supports_skills: true,
  changes: { turn_diff: true, per_file_patch: true, git_scopes: true },
};

test("RewindDialog selects file+conversation rewind by default when canRestoreFiles=true and shows manual-edits warning", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const calls: { restoreFiles: boolean }[] = [];
  const completions: unknown[] = [];

  const preview: RewindPreview = {
    turnsToRemove: 2,
    canRestoreFiles: true,
    hasManualEditsWarning: true,
  };

  try {
    await act(async () => {
      root.render(
        createElement(RewindDialog, {
          target: { sessionId: "s1", userEventId: "u2" },
          onCancel: () => {},
          onComplete: (res) => completions.push(res),
          loadPreview: async () => preview,
          executeRewind: async (_sid, _eid, restoreFiles): Promise<RewindResult> => {
            calls.push({ restoreFiles });
            return {
              taskId: "t1",
              activeSessionId: "s1",
              restoredText: "重构接口\n\n附件：C:\\repo\\api.md",
              restoredImages: ["C:\\repo\\shot.png"],
              filesRestored: restoreFiles,
            };
          },
        }),
      );
    });

    const dialog = dom.document.body.querySelector("[data-rewind-dialog]");
    assert.ok(dialog);
    assert.match(dialog.textContent ?? "", /将撤回 2 轮对话/);

    const bothRadio = dialog.querySelector('[data-rewind-mode="both"]') as unknown as HTMLButtonElement;
    const convRadio = dialog.querySelector('[data-rewind-mode="conversation"]') as unknown as HTMLButtonElement;
    assert.equal(bothRadio?.getAttribute("aria-checked"), "true");
    assert.equal(convRadio?.getAttribute("aria-checked"), "false");
    assert.ok(dialog.querySelector("[data-rewind-manual-warning]"), "manual edits warning should show");

    // Switching to conversation-only hides manual edits warning
    await act(async () => convRadio.click());
    assert.equal( dialog.querySelector("[data-rewind-manual-warning]"), null);

    // Switch back to both and confirm
    await act(async () => bothRadio.click());
    assert.ok(dialog.querySelector("[data-rewind-manual-warning]"));

    const confirmBtn = dialog.querySelector("[data-rewind-confirm]") as unknown as HTMLButtonElement;
    await act(async () => confirmBtn.click());

    assert.deepEqual(calls, [{ restoreFiles: true }]);
    assert.deepEqual(completions, [
      {
        activeSessionId: "s1",
        text: "重构接口",
        files: [
          { path: "C:\\repo\\shot.png", name: "shot.png" },
          { path: "C:\\repo\\api.md", name: "api.md" },
        ],
        filesRestored: true,
      },
    ]);
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.remove();
  }
});

test("RewindDialog disables file restore and shows fileRestoreDisabledReason when canRestoreFiles=false", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const calls: boolean[] = [];

  const preview: RewindPreview = {
    turnsToRemove: 1,
    canRestoreFiles: false,
    fileRestoreDisabledReason: "当前目录不在 Git 仓库中，无法还原工作区文件",
    hasManualEditsWarning: false,
  };

  try {
    await act(async () => {
      root.render(
        createElement(RewindDialog, {
          target: { sessionId: "s1", userEventId: "u1" },
          onCancel: () => {},
          onComplete: () => {},
          loadPreview: async () => preview,
          executeRewind: async (_sid, _eid, restoreFiles): Promise<RewindResult> => {
            calls.push(restoreFiles);
            return {
              taskId: "t1",
              activeSessionId: "s1",
              restoredText: "hello",
              restoredImages: [],
              filesRestored: false,
            };
          },
        }),
      );
    });

    const dialog = dom.document.body.querySelector("[data-rewind-dialog]")!;
    const bothRadio = dialog.querySelector('[data-rewind-mode="both"]') as unknown as HTMLButtonElement;
    const convRadio = dialog.querySelector('[data-rewind-mode="conversation"]') as unknown as HTMLButtonElement;
    assert.equal(bothRadio.disabled, true);
    assert.equal(convRadio.getAttribute("aria-checked"), "true");
    assert.match(
      dialog.querySelector("[data-rewind-files-disabled-reason]")?.textContent ?? "",
      /当前目录不在 Git 仓库中/,
    );

    await act(async () => (dialog.querySelector("[data-rewind-confirm]") as unknown as HTMLButtonElement).click());
    assert.deepEqual(calls, [false]);
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.remove();
  }
});

test("UserBubble gates rewind action on capability and disables with tooltip while session is running", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const requested: Array<[string, string]> = [];
  const event: SessionEvent = {
    id: "evt-u1",
    session_id: "s1",
    seq: 1,
    ts: 1000,
    kind: "user-message",
    text: "测试消息",
  };
  const baseSession: Session = {
    id: "s1",
    native_id: "n1",
    project_id: "p1",
    agent: "claude-code",
    title: "会话",
    status: "completed",
    created_at: 1,
    updated_at: 1,
  };

  try {
    // 1. Capability true + idle -> enabled button + context menu item
    await act(async () => {
      root.render(
        createElement(ChatHostProvider, {
          host: {
            answerPrompt: async () => false,
            projectPath: "",
            requestRewind: (sid, uid) => requested.push([sid, uid]),
            profiles: {
              "claude-code": {
                kind: "claude-code",
                capabilities: { ...baseCaps, supports_conversation_rewind: true },
                commands: [],
              },
            },
          },
          children: createElement(MessageMenuProvider, {
            sessionId: "s1",
            children: createElement(UserBubble, {
              event,
              session: baseSession,
              resolvedAnswer: null,
              time: "12:00",
              thinkingOpen: false,
              onToggleThinking: () => {},
              showAgentLabel: false,
            }),
          }),
        }),
      );
    });
    const btn = host.querySelector("[data-rewind-turn]") as unknown as HTMLButtonElement;
    assert.ok(btn);
    assert.equal(btn.disabled, false);
    await act(async () => btn.click());
    assert.deepEqual(requested, [["s1", "evt-u1"]]);

    // 2. Running session -> disabled with tooltip
    await act(async () => {
      root.render(
        createElement(ChatHostProvider, {
          host: {
            answerPrompt: async () => false,
            projectPath: "",
            requestRewind: (sid, uid) => requested.push([sid, uid]),
            profiles: {
              "claude-code": {
                kind: "claude-code",
                capabilities: { ...baseCaps, supports_conversation_rewind: true },
                commands: [],
              },
            },
          },
          children: createElement(UserBubble, {
            event,
            session: { ...baseSession, status: "running" },
            resolvedAnswer: null,
            time: "12:00",
            thinkingOpen: false,
            onToggleThinking: () => {},
            showAgentLabel: false,
          }),
        }),
      );
    });
    const busyBtn = host.querySelector("[data-rewind-turn]") as unknown as HTMLButtonElement;
    assert.equal(busyBtn.disabled, true);
    assert.equal(busyBtn.title, "请先等待或停止当前回合");

    // 2b. needs-input session -> also disabled while awaiting approval/question
    await act(async () => {
      root.render(
        createElement(ChatHostProvider, {
          host: {
            answerPrompt: async () => false,
            projectPath: "",
            requestRewind: (sid, uid) => requested.push([sid, uid]),
            profiles: {
              "claude-code": {
                kind: "claude-code",
                capabilities: { ...baseCaps, supports_conversation_rewind: true },
                commands: [],
              },
            },
          },
          children: createElement(UserBubble, {
            event,
            session: { ...baseSession, status: "needs-input" },
            resolvedAnswer: null,
            time: "12:00",
            thinkingOpen: false,
            onToggleThinking: () => {},
            showAgentLabel: false,
          }),
        }),
      );
    });
    const needsInputBtn = host.querySelector("[data-rewind-turn]") as unknown as HTMLButtonElement;
    assert.equal(needsInputBtn.disabled, true);
    assert.equal(needsInputBtn.title, "请先等待或停止当前回合");

    // 3. Capability false -> hidden
    await act(async () => {
      root.render(
        createElement(ChatHostProvider, {
          host: {
            answerPrompt: async () => false,
            projectPath: "",
            requestRewind: (sid, uid) => requested.push([sid, uid]),
            profiles: {
              "claude-code": {
                kind: "claude-code",
                capabilities: { ...baseCaps, supports_conversation_rewind: false },
                commands: [],
              },
            },
          },
          children: createElement(UserBubble, {
            event,
            session: baseSession,
            resolvedAnswer: null,
            time: "12:00",
            thinkingOpen: false,
            onToggleThinking: () => {},
            showAgentLabel: false,
          }),
        }),
      );
    });
    assert.equal(host.querySelector("[data-rewind-turn]"), null);
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.remove();
  }
});
