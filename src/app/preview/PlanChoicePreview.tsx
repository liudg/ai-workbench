import { useEffect } from "react";

import { AnswerMarkdownHost } from "@/features/chat/answer/AnswerMarkdownHost";
import { ChatView } from "@/features/chat/timeline/ChatView";
import { PanelProvider } from "@/features/panel/core/PanelProvider";
import { SessionSplit } from "@/features/panel/core/SessionSplit";
import { useWorkbench } from "@/store";
import type { Session, SessionEvent, SessionEventBody } from "@/types";

const sessionId = "plan-choice-preview";

function session(): Session {
  return {
    id: sessionId,
    project_id: "preview",
    agent: "codex-cli",
    native_id: sessionId,
    title: "贪吃蛇",
    status: "completed",
    created_at: 1,
    updated_at: 1,
  };
}

function event(id: string, seq: number, ts: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: sessionId, seq, ts, ...body };
}

const events: SessionEvent[] = [
  event("mode", 1, 1_000, { kind: "collaboration-mode", mode: "plan" }),
  event("user", 2, 2_000, { kind: "user-message", text: "做一个贪吃蛇" }),
  event("think", 3, 3_000, { kind: "thinking", text: "先看目录" }),
  event("tool", 4, 4_000, { kind: "tool-call", name: "command", summary: "ls" }),
  event("answer", 5, 29_000, {
    kind: "agent-message",
    text: "当前目录没有可复用的页面。这个贪吃蛇会做成单页可玩的浏览器游戏。",
    phase: "final-answer",
    mode: "plan",
  }),
  event("status", 6, 29_100, { kind: "status-changed", status: "completed" }),
  event("ask", 7, 29_200, {
    kind: "prompt",
    prompt_id: "implement-plan-1",
    prompt_kind: "choice",
    question: "实施此计划？",
    options: [
      {
        id: "implement",
        label: "是，实施此计划",
        description: "切换到默认模式并开始编码",
        slot: "primary",
      },
      {
        id: "clear-context",
        label: "是，清空上下文并实施",
        description: "用这份计划开一个新线程（当前上下文：57%）",
        slot: "leading",
      },
      {
        id: "stay",
        label: "否，留在计划模式",
        description: "继续和模型完善计划",
        slot: "deny",
      },
    ],
    questions: [],
  }),
];

/** 开发预览：计划回合结束后，确认面板在输入框上方。`?preview=plan-choice` */
export default function PlanChoicePreview() {
  useEffect(() => {
    useWorkbench.setState({
      profiles: {
        "codex-cli": {
          kind: "codex-cli",
          display_name: "Codex CLI",
          icon: "",
          commands: [],
          capabilities: {
            supports_slash: true,
            supports_resume: false,
            supports_questions: true,
            supports_tuning: false,
            supports_skills: false,
            supports_plan: true,
            supports_queue: true,
            changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
          },
        },
      },
    });
  }, []);
  const current = session();
  return (
    <div className="h-screen w-screen bg-[var(--wb-canvas)] text-[var(--wb-text)]">
      <PanelProvider
        sessionId={sessionId}
        projectId="preview"
        projectPath=""
        sessionTitle={current.title}
        agent="codex-cli"
        events={events}
        usage={null}
      >
        <AnswerMarkdownHost>
          <SessionSplit>
            <ChatView session={current} events={events} />
          </SessionSplit>
        </AnswerMarkdownHost>
      </PanelProvider>
    </div>
  );
}
