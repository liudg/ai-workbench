import { useEffect, useMemo } from "react";

import { useWorkbench } from "@/store";

import { ChatView } from "@/features/chat/timeline/ChatView";
import { AnswerMarkdownHost } from "@/features/workspace/AnswerMarkdownHost";
import { PanelProvider } from "@/features/panel/core/PanelProvider";
import { SessionSplit } from "@/features/panel/core/SessionSplit";
import { accumulateSessionUsage } from "@/store/session-usage";
import type { Session, SessionEvent } from "@/types";

function session(id: string, title: string, status: Session["status"] = "completed"): Session {
  return {
    id,
    project_id: "preview",
    agent: "claude-code",
    native_id: id,
    title,
    status,
    created_at: 1,
    updated_at: 1,
  };
}

function user(id: string, sessionId: string, text: string): SessionEvent {
  return { id, session_id: sessionId, seq: 1, ts: 1, kind: "user-message", text };
}

const supportedEvents: SessionEvent[] = [
  user("user-on", "usage-on", "帮我看一下这个模块"),
  {
    id: "ctx",
    session_id: "usage-on",
    seq: 2,
    ts: 2,
    kind: "context-usage",
    source: "get_context_usage",
    used_tokens: 45137,
    max_tokens: 200000,
    percentage: 23,
  },
  {
    id: "tool-status",
    session_id: "usage-on",
    seq: 3,
    ts: 1000,
    kind: "tool-call",
    name: "bash",
    summary: "git status",
  },
  {
    id: "tool-read",
    session_id: "usage-on",
    seq: 4,
    ts: 2000,
    kind: "tool-call",
    name: "read",
    summary: "src/features/panel/viewers/SourceView.tsx",
  },
  {
    id: "agent",
    session_id: "usage-on",
    seq: 5,
    ts: 7000,
    kind: "agent-message",
    text: "这一轮已经记进会话累计。改动落在查看器，用量记在顶栏。",
    phase: "final-answer",
  },
  {
    id: "snap",
    session_id: "usage-on",
    seq: 6,
    ts: 8,
    kind: "session-usage",
    scope: "snapshot",
    input_tokens: 5000,
    output_tokens: 1000,
    cache_read_tokens: 1000,
  },
  {
    id: "delta",
    session_id: "usage-on",
    seq: 7,
    ts: 9,
    kind: "session-usage",
    scope: "delta",
    key: "result:turn-2",
    input_tokens: 3000,
    output_tokens: 1300,
    cache_read_tokens: 500,
    cache_write_tokens: 500,
  },
];

const runningEvents: SessionEvent[] = [
  user("user-run", "usage-run", "继续看文件树"),
  {
    id: "run-status",
    session_id: "usage-run",
    seq: 2,
    ts: 2,
    kind: "status-changed",
    status: "running",
  },
  {
    id: "run-tool",
    session_id: "usage-run",
    seq: 3,
    ts: 3,
    kind: "tool-call",
    name: "bash",
    summary: "git diff --stat",
  },
];

const unsupportedEvents: SessionEvent[] = [
  user("user-off", "usage-off", "这个适配器没有用量"),
  {
    id: "ctx-off",
    session_id: "usage-off",
    seq: 2,
    ts: 2,
    kind: "context-usage",
    source: "get_context_usage",
    used_tokens: 45137,
    max_tokens: 200000,
  },
  {
    id: "agent-off",
    session_id: "usage-off",
    seq: 3,
    ts: 3,
    kind: "agent-message",
    text: "这里不显示 token。",
    phase: "final-answer",
  },
];

function Frame({
  id,
  title,
  events,
  status = "completed",
}: {
  id: string;
  title: string;
  events: SessionEvent[];
  status?: Session["status"];
}) {
  const usage = useMemo(() => accumulateSessionUsage(events), [events]);
  return (
    <div data-usage-frame={id} className="h-[50vh] min-h-0 border-b border-zinc-800">
      <PanelProvider
        sessionId={id}
        projectId="preview"
        projectPath=""
        sessionTitle={title}
        agent="claude-code"
        events={events}
        usage={usage}
      >
        <AnswerMarkdownHost>
          <SessionSplit>
            <ChatView session={session(id, title, status)} events={events} />
          </SessionSplit>
        </AnswerMarkdownHost>
      </PanelProvider>
    </div>
  );
}

/** 开发预览：顶栏总量、悬停分项，以及没有用量时不渲染。 */
export default function UsagePreview() {
  useEffect(() => {
    useWorkbench.setState({
      profiles: {
        "claude-code": {
          kind: "claude-code",
          display_name: "Claude Code",
          icon: "/agent-icons/claude.svg",
          commands: [],
          default_access: null,
          capabilities: {
            supports_slash: false,
            supports_resume: false,
            supports_questions: false,
            supports_tuning: false,
            supports_skills: false,
            changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
          },
        },
      },
    });
  }, []);
  return (
    <div className="h-screen w-screen overflow-hidden bg-[#0f0f0f] text-[#e8e8e8]">
      <Frame id="usage-on" title="整理会话用量" events={supportedEvents} />
      <Frame id="usage-run" title="整理会话用量" events={runningEvents} status="running" />
      <Frame id="usage-off" title="未报告用量" events={unsupportedEvents} />
    </div>
  );
}
