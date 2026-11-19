import { useCallback, useMemo, useRef, useState } from "react";

import {
  AnswerMarkdownHost,
  ChatHostProvider,
  ChatView,
  Composer,
  type ChatHost,
  type ComposerHost,
} from "@/features/chat";
import type { AgentCapabilities, AgentProfile, Session, SessionEvent, SessionEventBody } from "@/types";
import { previewComposerHost } from "./PreviewSession";

const sessionId = "background-tasks-preview";

const CAPS: AgentCapabilities = {
  supports_slash: true,
  supports_resume: true,
  supports_questions: true,
  supports_tuning: true,
  supports_skills: true,
  supports_images: true,
  supports_queue: true,
  supports_cancel: true,
  supports_plan: true,
  supports_background_task_stop: true,
  changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
};

const PROFILE: AgentProfile = {
  kind: "claude-code",
  capabilities: CAPS,
  commands: [],
  display_name: "Claude Code",
};

const SESSION: Session = {
  id: sessionId,
  project_id: "preview",
  agent: "claude-code",
  native_id: sessionId,
  title: "后台任务预览",
  status: "completed",
  created_at: 1,
  updated_at: 1,
};

function makeEvent(id: string, seq: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: sessionId, seq, ts: Date.now() - (30 - seq) * 1_000, ...body };
}

function initialEvents(): SessionEvent[] {
  const now = Date.now();
  return [
    makeEvent("u1", 1, {
      kind: "user-message",
      text: "在后台把前端开发服务器和监听脚本跑起来，不用等它们退出。",
    }),
    makeEvent("c1", 2, {
      kind: "tool-call",
      name: "command",
      summary: "pnpm dev --port 4573",
      detail: "  VITE v6.2.0  ready in 312 ms\n  ➜  Local:   http://localhost:4573/\n[vite] connected.",
      stream_id: "call_dev",
      status: "running",
    }),
    makeEvent("b1", 3, {
      kind: "background-task",
      task_id: "bg_dev",
      task_type: "terminal",
      tool_call_id: "call_dev",
      title: "pnpm dev --port 4573",
      status: "running",
      started_at: now - 42_000,
    }),
    makeEvent("c2", 4, {
      kind: "tool-call",
      name: "command",
      summary: "sleep 300 && echo BG-DONE",
      detail: "Command running in background with ID: bg_bash.",
      stream_id: "call_bash",
      status: "completed",
    }),
    makeEvent("b2", 5, {
      kind: "background-task",
      task_id: "bg_bash",
      task_type: "local_bash",
      tool_call_id: "call_bash",
      title: "后台监听构建产物",
      output_file: "/tmp/bg_bash.output",
      status: "running",
      started_at: now - 16_000,
    }),
    makeEvent("a1", 6, {
      kind: "agent-message",
      text: "已在后台启动开发预览服务和构建监听。你可以点击下方输入框右上角的后台胶囊查看实时输出或单独停止任务。",
      phase: "final-answer",
    }),
    makeEvent("s1", 7, { kind: "status-changed", status: "completed" }),
  ];
}

/** 开发预览：后台任务胶囊与时间线原地校准。`?preview=background-tasks` */
export default function BackgroundTasksPreview() {
  const [events, setEvents] = useState<SessionEvent[]>(initialEvents);
  const [canStop, setCanStop] = useState(true);
  const readSeq = useRef(0);

  const profile = useMemo<AgentProfile>(
    () => ({
      ...PROFILE,
      capabilities: { ...CAPS, supports_background_task_stop: canStop },
    }),
    [canStop],
  );

  const stopTask = useCallback(async (taskId: string) => {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    setEvents((prev) =>
      prev.map((item) => {
        if (item.kind === "background-task" && item.task_id === taskId && item.status === "running") {
          return { ...item, status: "stopped", exit_code: -1, ended_at: Date.now() };
        }
        return item;
      }),
    );
  }, []);

  const readOutput = useCallback(async (path: string) => {
    readSeq.current += 1;
    return `[watch:${path}] build check passed (#${readSeq.current})\nWatching src/features/chat for changes...`;
  }, []);

  const chatHost = useMemo<ChatHost>(
    () => ({
      answerPrompt: async () => true,
      profiles: { "claude-code": profile },
      projectPath: "",
      stopBackgroundTask: (_sid, taskId) => stopTask(taskId),
      readTaskOutput: (_sid, path) => readOutput(path),
    }),
    [profile, readOutput, stopTask],
  );

  const composerHost = useMemo<ComposerHost>(
    () => ({
      ...previewComposerHost({ profile }),
      worktree: {
        showToggle: false,
        pressed: false,
        onToggle: () => {},
        liveLabel: "main",
        liveTitle: "G:/document/ai-workbench",
      },
      stopBackgroundTask: stopTask,
      readTaskOutput: readOutput,
    }),
    [profile, readOutput, stopTask],
  );

  return (
    <div className="flex h-screen w-screen flex-col bg-wb-surface text-wb-fg">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-wb-border bg-wb-elev px-4 text-xs">
        <span className="font-medium">后台任务预览</span>
        <div className="flex items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-wb-fg-2">
            <input
              type="checkbox"
              checked={canStop}
              onChange={(e) => setCanStop(e.target.checked)}
            />
            <span>supports_background_task_stop</span>
          </label>
          <button
            type="button"
            onClick={() => {
              readSeq.current = 0;
              setEvents(initialEvents());
            }}
            className="rounded-md border border-wb-border bg-wb-card px-2 py-1 text-wb-fg hover:bg-wb-hover"
          >
            重置演示
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatHostProvider host={chatHost}>
          <AnswerMarkdownHost>
            <ChatView
              session={SESSION}
              events={events}
              renderComposer={(anchorRef) => (
                <Composer
                  host={composerHost}
                  session={SESSION}
                  events={events}
                  anchorRef={anchorRef}
                />
              )}
            />
          </AnswerMarkdownHost>
        </ChatHostProvider>
      </div>
    </div>
  );
}
