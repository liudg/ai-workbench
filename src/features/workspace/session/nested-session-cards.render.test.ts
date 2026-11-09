import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer } from "vite";
import type { TaskEntry } from "../../tasks/types.ts";
import type { Session, SessionEvent } from "../../../types/index.ts";

test("nested session cards remain in the reply and both copies navigate to their session", async () => {
  const dom = new Window({ url: "http://localhost/" });
  const globals = { IS_REACT_ACT_ENVIRONMENT: true, window: dom, document: dom.document,
    navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
  const server = await createServer({ root: rootDir, server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  try {
    const daemon = await server.ssrLoadModule("/src/lib/daemon/index.ts");
    const { useSubtaskHost } = await server.ssrLoadModule("/src/features/workspace/session/use-subtask-host.ts");
    const { ChatHostProvider } = await server.ssrLoadModule("/src/features/chat/host.tsx");
    const { TurnProcess } = await server.ssrLoadModule("/src/features/chat/timeline/TurnProcess.tsx");
    const navigation = await server.ssrLoadModule("/src/shared/shell/navigation.ts");
    const tasks: TaskEntry[] = ["project-child", "standalone-child"].map((id, index) => ({
      id, projectId: index === 0 ? "child-project" : undefined, title: id, parentTaskId: "parent",
      workspace: { kind: "root" }, pinned: false, createdAt: 1, updatedAt: 1,
      attention: { state: "working", unread: false, updatedAt: 1 },
      sessions: [{ id: `${id}-session`, taskId: id, agent: "codex-cli", status: "running", options: {}, createdAt: 1, updatedAt: 1 }],
    }));
    let publishTasks: (value: TaskEntry[]) => void = () => { throw new Error("Tasks not subscribed"); };
    daemon.daemon.disable("test");
    daemon.daemon.subscribe = (topic: string, listener: (value: TaskEntry[]) => void) => {
      assert.equal(topic, daemon.TOPIC_TASKS);
      publishTasks = listener;
      return () => {};
    };
    const session: Session = { id: "parent", native_id: "parent", project_id: "parent-project", agent: "codex-cli",
      title: "parent", status: "completed", created_at: 1, updated_at: 1 };
    const events: SessionEvent[] = [
      { id: "offer", session_id: "parent", seq: 1, ts: 1, kind: "subtask-offer",
      link: "child", offer_id: "offer",
        initiation: "own_initiative", subtasks: tasks.map((task) => ({ agent: "codex-cli", title: task.title, prompt: "创建页面" })),
        resolution: { kind: "accepted", task_ids: tasks.map((task) => task.id) } },
      { id: "answer", session_id: "parent", seq: 2, ts: 2, kind: "agent-message", phase: "final-answer", text: "会话已开启。" },
    ];
    function Harness({ expanded }: { expanded: boolean }) {
      const subtasks = useSubtaskHost();
      const view = navigation.useNavigation((state: { view: unknown }) => state.view);
      return createElement(ChatHostProvider, { host: { subtasks, profiles: {}, projectPath: "", answerPrompt: async () => true } },
        createElement(TurnProcess, { events, answerId: "answer", durationMs: 1, session,
          resolvedAnswers: new Map(), expanded, onToggle: () => {} }),
        createElement("output", null, JSON.stringify(view)));
    }
    await act(async () => root.render(createElement(Harness, { expanded: true })));
    await act(async () => publishTasks(tasks));
    for (const task of tasks) {
      const cards = container.querySelectorAll(`[data-subtask-row="${task.id}"]`);
      assert.equal(cards.length, 2);
      assert.equal(container.querySelectorAll(`[data-activity-stream] [data-subtask-row="${task.id}"]`).length, 1);
      for (const card of cards) {
        await act(async () => navigation.openTask("parent", "parent-project"));
        await act(async () => card.querySelector("button")!.click());
        assert.deepEqual(JSON.parse(container.querySelector("output")!.textContent), {
          kind: "task", taskId: task.id, projectId: task.projectId ?? null,
        });
      }
    }
    await act(async () => publishTasks(tasks.map((task) => ({
      ...task, attention: { ...task.attention, state: "starting" },
      sessions: task.sessions.map((session) => ({ ...session, status: "starting" })),
    }))));
    assert.equal(container.querySelectorAll('[data-subtask-state="starting"]').length, 4);
    assert.ok(container.textContent.includes("正在启动"));
    assert.ok(!container.textContent.includes("完成"));
    await act(async () => publishTasks(tasks.map((task) => ({
      ...task, attention: { ...task.attention, state: "done" },
    }))));
    assert.equal(container.querySelectorAll('[data-subtask-state="done"]').length, 4);
    await act(async () => root.render(createElement(Harness, { expanded: false })));
    assert.equal(container.querySelectorAll("[data-subtask-row]").length, 2);
    assert.equal(container.querySelectorAll("[data-activity-stream] [data-subtask-row]").length, 0);
    assert.ok(container.textContent.includes("会话已开启。"));
  } finally {
    await act(async () => root.unmount());
    await server.close();
    await dom.happyDOM.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
