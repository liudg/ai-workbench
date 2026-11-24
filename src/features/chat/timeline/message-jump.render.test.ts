import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";

import type { Session, SessionEvent } from "../../../types/index.ts";

const dom = new Window({ url: "http://localhost/" });
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const globals = {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  SVGElement: dom.SVGElement,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  },
  cancelAnimationFrame: (id: number) => {
    frames.delete(id);
  },
};
const descriptors = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

let server: ViteDevServer;
let ChatView: typeof import("./ChatView.tsx").ChatView;
let ChatHostProvider: typeof import("../host.tsx").ChatHostProvider;
let navigation: typeof import("../../../shared/shell/navigation.ts");
let timelineMod: typeof import("./timeline.ts");

before(async () => {
  const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
  server = await createServer({
    root: rootDir,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "error",
  });
  ChatView = (await server.ssrLoadModule("/src/features/chat/timeline/ChatView.tsx")).ChatView;
  ChatHostProvider = (await server.ssrLoadModule("/src/features/chat/host.tsx")).ChatHostProvider;
  navigation = (await server.ssrLoadModule(
    "/src/shared/shell/navigation.ts",
  )) as typeof navigation;
  timelineMod = (await server.ssrLoadModule(
    "/src/features/chat/timeline/timeline.ts",
  )) as typeof timelineMod;
});

after(async () => {
  await server?.close();
  await dom.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function flushFrames() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) cb(0);
  });
}

test("ChatView auto-expands a folded TurnProcess, highlights query in target event, scrolls into view, and clears pendingJump", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);

  const session: Session = {
    id: "sess-1",
    native_id: "n-1",
    project_id: "proj-1",
    agent: "codex-cli",
    title: "测试跳转",
    status: "completed",
    created_at: 1,
    updated_at: 10,
  };

  const events: SessionEvent[] = [
    {
      id: "u-1",
      session_id: "sess-1",
      seq: 1,
      ts: 1000,
      kind: "user-message",
      text: "排查一下缓存穿透问题",
    },
    {
      id: "commentary-1",
      session_id: "sess-1",
      seq: 2,
      ts: 2000,
      kind: "agent-message",
      phase: "commentary",
      text: "正在检查 Redis 缓存穿透与布隆过滤器配置",
    },
    {
      id: "ans-1",
      session_id: "sess-1",
      seq: 3,
      ts: 4000,
      kind: "agent-message",
      phase: "final-answer",
      text: "已完成修复。",
    },
  ];

  // Verify pure helper locates the settled turn block for commentary-1,
  // while returning null for already-visible final answer ans-1!
  const blocks = timelineMod.buildTimeline(events, "completed");
  const located = timelineMod.findTimelineContainerForEvent(blocks, "commentary-1");
  assert.equal(located.turnId, "commentary-1");
  const locatedAnswer = timelineMod.findTimelineContainerForEvent(blocks, "ans-1");
  assert.deepEqual(locatedAnswer, { turnId: null, liveId: null });

  // Also verify live turn block: folded process events return liveId, already-visible events return null
  const liveEvents: SessionEvent[] = [
    ...events,
    {
      id: "u-live",
      session_id: "sess-1",
      seq: 4,
      ts: 5000,
      kind: "user-message",
      text: "继续执行",
    },
    {
      id: "live-tool",
      session_id: "sess-1",
      seq: 5,
      ts: 5100,
      kind: "tool-call",
      name: "bash",
      summary: "运行检查",
      status: "running",
    },
    {
      id: "live-err",
      session_id: "sess-1",
      seq: 6,
      ts: 5200,
      kind: "error",
      message: "临时告警",
    },
  ];
  const liveBlocks = timelineMod.buildTimeline(liveEvents, "running");
  assert.equal(timelineMod.findTimelineContainerForEvent(liveBlocks, "live-tool").liveId, "live-u-live");
  assert.deepEqual(timelineMod.findTimelineContainerForEvent(liveBlocks, "live-err"), {
    turnId: null,
    liveId: null,
  });

  const scrolledElements: Array<{ attr: string | null; block: string | undefined }> = [];
  const originalScrollIntoView = dom.HTMLElement.prototype.scrollIntoView;
  dom.HTMLElement.prototype.scrollIntoView = function (options) {
    const el = this as unknown as HTMLElement;
    scrolledElements.push({
      attr: el.getAttribute("data-find-event") ?? el.getAttribute("data-thread-find-mark"),
      block: typeof options === "object" ? options.block : undefined,
    });
  };

  try {
    await act(async () => {
      root.render(
        createElement(ChatHostProvider, {
          host: { profiles: {}, projectPath: "", answerPrompt: async () => false },
          children: createElement(ChatView, {
            session,
            events,
            eventsReady: true,
            taskId: "task-jump-1",
            renderComposer: () => createElement("textarea", { "data-test-composer": "" }),
          }),
        }),
      );
    });

    // Initially, commentary-1 is folded inside TurnProcess and NOT in the DOM
    assert.equal(host.querySelector('[data-find-event="commentary-1"]'), null);

    // Trigger full-text search jump targeting commentary-1
    await act(async () => {
      navigation.openTask("task-jump-1", "proj-1", {
        eventId: "commentary-1",
        query: "布隆过滤器",
      });
    });
    await flushFrames();
    await flushFrames();

    // Folded TurnProcess auto-expanded so commentary-1 is now mounted & highlighted!
    const jumped = host.querySelector('[data-find-event="commentary-1"]') as unknown as HTMLElement;
    assert.ok(jumped, "folded commentary event should be expanded and mounted");
    assert.equal(jumped.getAttribute("data-jump-highlighted"), "true");
    assert.ok(
      scrolledElements.some((item) => item.attr === "commentary-1" && item.block === "center"),
      "target event should be scrolled into center",
    );

    // Thread find highlights the query inside commentary-1 without stealing focus
    const currentMark = jumped.querySelector('mark[data-thread-find-mark="current"]');
    assert.equal(currentMark?.textContent, "布隆过滤器");
    const findInput = host.querySelector("[data-thread-find] input") as unknown as HTMLInputElement;
    assert.ok(findInput);
    assert.notEqual(dom.document.activeElement, findInput as unknown, "should not steal focus on search jump");

    // pendingJump was cleared once handled
    let remainingJump: unknown = "not-read";
    function JumpProbe() {
      remainingJump = navigation.useNavigation((s) => s.pendingJump);
      return null;
    }
    const probeHost = dom.document.createElement("div");
    const probeRoot = createRoot(probeHost as unknown as HTMLElement);
    await act(async () => probeRoot.render(createElement(JumpProbe)));
    assert.equal(remainingJump, null);
    await act(async () => probeRoot.unmount());
  } finally {
    dom.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    frames.clear();
    await act(async () => root.unmount());
    host.remove();
  }
});

test("ChatView clears pendingJump for suppressed duplicate events and multi-term FTS jumps stay centered on targetNode without yanking to earlier messages", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);

  const session: Session = {
    id: "sess-2",
    native_id: "n-2",
    project_id: "proj-2",
    agent: "codex-cli",
    title: "多词与抑制事件跳转",
    status: "completed",
    created_at: 1,
    updated_at: 20,
  };

  const events: SessionEvent[] = [
    {
      id: "u-early",
      session_id: "sess-2",
      seq: 1,
      ts: 1000,
      kind: "user-message",
      text: "之前遇到过 deadlock 超时 报错",
    },
    {
      id: "plan-1",
      session_id: "sess-2",
      seq: 2,
      ts: 2000,
      kind: "plan-text",
      mode: "plan",
      text: "排查方案步骤",
    },
    // Suppressed duplicate plan agent-message: exists in `events`, absent from `blocks`!
    {
      id: "dup-plan-msg",
      session_id: "sess-2",
      seq: 3,
      ts: 2100,
      kind: "agent-message",
      mode: "plan",
      phase: "final-answer",
      text: "排查方案步骤",
    },
    {
      id: "u-2",
      session_id: "sess-2",
      seq: 4,
      ts: 3000,
      kind: "user-message",
      text: "继续看连接池日志",
    },
    {
      id: "target-split",
      session_id: "sess-2",
      seq: 5,
      ts: 4000,
      kind: "agent-message",
      phase: "final-answer",
      text: "连接池在高并发下触发了 deadlock，随后发生请求超时回滚。详见 [文档](https://internal.example/only-in-url-token)。",
    },
  ];

  const scrolledTargets: string[] = [];
  const originalScrollIntoView = dom.HTMLElement.prototype.scrollIntoView;
  dom.HTMLElement.prototype.scrollIntoView = function () {
    const el = this as unknown as HTMLElement;
    const ownerEvent = el.closest("[data-find-event]")?.getAttribute("data-find-event");
    scrolledTargets.push(ownerEvent ?? el.getAttribute("data-find-event") ?? "unknown");
  };

  let observedPendingJump: unknown = "unset";
  function JumpProbe() {
    observedPendingJump = navigation.useNavigation((s) => s.pendingJump);
    return null;
  }

  try {
    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(JumpProbe),
          createElement(ChatHostProvider, {
            host: { profiles: {}, projectPath: "", answerPrompt: async () => false },
            children: createElement(ChatView, {
              session,
              events,
              eventsReady: true,
              taskId: "task-jump-2",
              renderComposer: () => createElement("textarea", { "data-test-composer": "" }),
            }),
          }),
        ),
      );
    });

    // 1. Jumping to a suppressed event (`dup-plan-msg`) falls back cleanly and clears pendingJump immediately
    await act(async () => {
      navigation.openTask("task-jump-2", "proj-2", {
        eventId: "dup-plan-msg",
        query: "排查方案步骤",
      });
    });
    await flushFrames();
    await flushFrames();
    assert.equal(observedPendingJump, null);
    assert.ok(host.querySelector("[data-thread-find]"), "falls back to thread find for query");

    // 2. Multi-term FTS query ("deadlock 超时"): u-early has the contiguous phrase, while target-split has terms separated.
    // Must highlight the longest matching term ("deadlock") inside target-split and NEVER yank scroll to u-early!
    scrolledTargets.length = 0;
    await act(async () => {
      navigation.openTask("task-jump-2", "proj-2", {
        eventId: "target-split",
        query: "deadlock 超时",
      });
    });
    await flushFrames();
    await flushFrames();

    assert.equal(observedPendingJump, null);
    assert.equal(scrolledTargets.includes("u-early"), false, "must never yank scroll to earlier message");
    assert.equal(scrolledTargets[0], "target-split");
    const targetEl = host.querySelector('[data-find-event="target-split"]')!;
    assert.equal(targetEl.getAttribute("data-jump-highlighted"), "true");
    const currentMark = targetEl.querySelector('mark[data-thread-find-mark="current"]');
    assert.equal(currentMark?.textContent, "deadlock");

    // 3. Query matching only stripped Markdown URL ("only-in-url-token"): must NOT leave FindBar open with 0/0!
    scrolledTargets.length = 0;
    await act(async () => {
      navigation.openTask("task-jump-2", "proj-2", {
        eventId: "target-split",
        query: "only-in-url-token",
      });
    });
    await flushFrames();
    await flushFrames();

    assert.equal(observedPendingJump, null);
    assert.equal(host.querySelector("[data-thread-find]"), null, "FindBar should not open with 0/0 hits");
    assert.equal(scrolledTargets[0], "target-split");
  } finally {
    dom.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    frames.clear();
    await act(async () => root.unmount());
    host.remove();
  }
});

test("ChatView does NOT expand TurnProcess when jumping to visible final answer, and waits for thinking/tool expansion before activating FindBar", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);

  const session: Session = {
    id: "sess-custom",
    native_id: "n-custom",
    project_id: "proj-3",
    agent: "claude-code",
    title: "折叠精确展开与实例隔离",
    status: "completed",
    created_at: 1,
    updated_at: 30,
  };

  const events: SessionEvent[] = [
    {
      id: "u-hist",
      session_id: "sess-default",
      seq: 1,
      ts: 1000,
      kind: "user-message",
      text: "排查死锁原因",
    },
    {
      id: "think-hist",
      session_id: "sess-default",
      seq: 2,
      ts: 2000,
      kind: "thinking",
      text: "初步分析锁顺序\n\n深层死锁根因是 mutex_order_inversion 导致互等",
    },
    {
      id: "tool-hist",
      session_id: "sess-default",
      seq: 3,
      ts: 2500,
      kind: "tool-call",
      name: "bash",
      summary: "cargo test --lib",
      detail: "panicked at lock_guard_poison_check",
      status: "completed",
    },
    {
      id: "ans-hist",
      session_id: "sess-default",
      seq: 4,
      ts: 4000,
      kind: "agent-message",
      phase: "final-answer",
      text: "定位完毕：请参考 `fetch_user_token` 的锁顺序修复。",
    },
  ];

  const originalScrollIntoView = dom.HTMLElement.prototype.scrollIntoView;
  dom.HTMLElement.prototype.scrollIntoView = function () {};

  try {
    await act(async () => {
      root.render(
        createElement(ChatHostProvider, {
          host: {
            answerPrompt: async () => false,
            projectPath: "",
            agentOf: () => "claude-code" as const,
            // sess-default belongs to default instance (undefined), while active sess-custom has custom instance
            instanceOf: (sid) => (sid === "sess-custom" ? "inst-enterprise" : undefined),
            profiles: {
              "claude-code": {
                kind: "claude-code",
                display_name: "Claude 默认实例",
                capabilities: {
                  supports_slash: true,
                  supports_resume: true,
                  supports_questions: true,
                  supports_tuning: true,
                  supports_skills: true,
                  changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
                },
                commands: [],
              },
              "inst-enterprise": {
                kind: "claude-code",
                display_name: "Claude 企业专线",
                capabilities: {
                  supports_slash: true,
                  supports_resume: true,
                  supports_questions: true,
                  supports_tuning: true,
                  supports_skills: true,
                  changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
                },
                commands: [],
              },
            },
          },
          children: createElement(ChatView, {
            session,
            events,
            eventsReady: true,
            taskId: "task-jump-3",
            renderComposer: () => createElement("textarea", { "data-test-composer": "" }),
          }),
        }),
      );
    });

    // R2-FE2-B3: Historical segment on default instance (instanceId === undefined) must NOT inherit active session's custom instanceId!
    assert.match(host.textContent ?? "", /Claude 默认实例 · 用时 3s/);
    assert.doesNotMatch(host.textContent ?? "", /Claude 企业专线 · 用时/);

    // (a) Jumping to settled turn's already-visible final answer `ans-hist` must NOT pop open TurnProcess!
    // Also verifies R2-FE2-B4 inline backtick query "`fetch_user_token`" highlights `fetch_user_token` in FindBar!
    await act(async () => {
      navigation.openTask("task-jump-3", "proj-3", {
        eventId: "ans-hist",
        query: "`fetch_user_token`",
      });
    });
    await flushFrames();
    await flushFrames();

    assert.equal(
      host.querySelector('[data-find-event="think-hist"]'),
      null,
      "TurnProcess intermediate steps must remain collapsed when jumping to final answer",
    );
    const ansEl = host.querySelector('[data-find-event="ans-hist"]')!;
    assert.equal(ansEl.getAttribute("data-jump-highlighted"), "true");
    assert.equal(
      ansEl.querySelector('mark[data-thread-find-mark="current"]')?.textContent,
      "fetch_user_token",
    );

    // (b) Now manually expand TurnProcess first so `[data-find-event="think-hist"]` is mounted in collapsed summary state,
    // then jump to `think-hist` for text that ONLY exists inside the collapsed thinking body ("mutex_order_inversion")!
    const foldToggle = host.querySelector("button[aria-expanded='false']") as unknown as HTMLButtonElement;
    assert.ok(foldToggle);
    await act(async () => {
      foldToggle.click();
    });
    const collapsedThinkEl = host.querySelector('[data-find-event="think-hist"]')!;
    assert.ok(collapsedThinkEl, "thinking summary wrapper is in DOM while body is still collapsed");
    assert.equal(collapsedThinkEl.textContent?.includes("mutex_order_inversion"), false);

    await act(async () => {
      navigation.openTask("task-jump-3", "proj-3", {
        eventId: "think-hist",
        query: "mutex_order_inversion",
      });
    });
    await flushFrames();
    await flushFrames();

    const expandedThinkEl = host.querySelector('[data-find-event="think-hist"]')!;
    assert.equal(expandedThinkEl.getAttribute("data-jump-highlighted"), "true");
    assert.equal(
      expandedThinkEl.querySelector('mark[data-thread-find-mark="current"]')?.textContent,
      "mutex_order_inversion",
      "FindBar must activate AFTER thinking block expansion commits so body hit is highlighted",
    );

    // Also jump to collapsed tool-call group (`tool-hist`) for text inside `detail` ("lock_guard_poison_check")
    const collapsedToolEl = host.querySelector('[data-find-event="tool-hist"]')!;
    assert.ok(collapsedToolEl);
    assert.equal(collapsedToolEl.textContent?.includes("lock_guard_poison_check"), false);

    await act(async () => {
      navigation.openTask("task-jump-3", "proj-3", {
        eventId: "tool-hist",
        query: "lock_guard_poison_check",
      });
    });
    await flushFrames();
    await flushFrames();

    const expandedToolEl = host.querySelector('[data-find-event="tool-hist"]')!;
    assert.equal(expandedToolEl.getAttribute("data-jump-highlighted"), "true");
    assert.equal(
      expandedToolEl.querySelector('mark[data-thread-find-mark="current"]')?.textContent,
      "lock_guard_poison_check",
      "FindBar must activate AFTER tool group expansion commits so detail hit is highlighted",
    );
  } finally {
    dom.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    frames.clear();
    await act(async () => root.unmount());
    host.remove();
  }
});
