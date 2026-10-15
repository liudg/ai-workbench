import { useEffect } from "react";

import { useWorkbench } from "@/store";
import { AnswerMarkdownHost } from "@/features/workspace/AnswerMarkdownHost";
import { PanelProvider } from "@/features/panel/core/PanelProvider";
import { SessionSplit } from "@/features/panel/core/SessionSplit";
import { ChatView } from "@/features/chat/timeline/ChatView";
import type { Session, SessionEvent, SessionEventBody, SessionStatus } from "@/types";

function session(id: string, title: string, status: SessionStatus): Session {
  return {
    id,
    project_id: "preview",
    agent: "codex-cli",
    native_id: id,
    title,
    status,
    created_at: 1,
    updated_at: 1,
  };
}

function event(sessionId: string, id: string, seq: number, ts: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: sessionId, seq, ts, ...body };
}

const liveEvents: SessionEvent[] = [
  event("activity-live", "user", 1, 1_000, { kind: "user-message", text: "按图片调整装备对比提示。" }),
  event("activity-live", "narration", 2, 2_000, {
    kind: "agent-message",
    phase: "commentary",
    text: "我会按图片调整装备对比提示的评分颜色、箭头和替换按钮，此次使用 unity-ui-ugui 技能。",
  }),
  event("activity-live", "mcp", 3, 3_000, {
    kind: "tool-call",
    name: "execute_code",
    summary: "MCP Unitymcp execute_code",
  }),
  event("activity-live", "found", 4, 4_000, {
    kind: "agent-message",
    phase: "commentary",
    text: "已找到装备对比组件和普通详情入口。当前替换按钮使用固定控制。详情预制体已有本地修改，我会保留这些内容。",
  }),
  event("activity-live", "think", 5, 5_000, { kind: "thinking", text: "思考中…" }),
  event("activity-live", "status", 6, 5_100, { kind: "status-changed", status: "running" }),
];

const doneEvents: SessionEvent[] = [
  event("activity-done", "user", 1, 1_000, { kind: "user-message", text: "验收链接里标记已修复的缺陷。" }),
  event("activity-done", "narration", 2, 2_000, {
    kind: "agent-message",
    phase: "commentary",
    text: "我已经查看了当前页面的缺陷表格，并通过 Chrome 和 Unitymcp 集成执行了相关操作。",
  }),
  event("activity-done", "think-1", 3, 3_000, { kind: "thinking", text: "先核对表格选区。" }),
  event("activity-done", "mcp-chrome", 4, 4_000, {
    kind: "tool-call",
    name: "browser_snapshot",
    summary: "MCP Chrome browser_snapshot",
  }),
  event("activity-done", "mcp-unity", 5, 5_000, {
    kind: "tool-call",
    name: "execute_code",
    summary: "MCP Unitymcp execute_code",
  }),
  event("activity-done", "think-2", 6, 6_000, { kind: "thinking", text: "再看复制操作。" }),
  event("activity-done", "cmd-1", 7, 7_000, { kind: "tool-call", name: "command", summary: "检查了表格选中" }),
  event("activity-done", "cmd-2", 8, 8_000, { kind: "tool-call", name: "command", summary: "查看了表格复制操作" }),
  event("activity-done", "cmd-3", 9, 9_000, {
    kind: "tool-call",
    name: "command",
    summary: "复制了缺陷记录选中（只读）",
  }),
  event("activity-done", "answer", 10, 10_000, {
    kind: "agent-message",
    phase: "final-answer",
    text: "当前表格中有一个缺陷记录被选中。我检查了选中状态，查看了可用的表格复制操作，并成功复制了选中的缺陷记录（只读模式）。",
  }),
  event("activity-done", "status", 11, 10_100, { kind: "status-changed", status: "completed" }),
];

function Frame({
  id,
  title,
  status,
  events,
}: {
  id: string;
  title: string;
  status: SessionStatus;
  events: SessionEvent[];
}) {
  const current = session(id, title, status);
  return (
    <div data-activity-frame={id} className="h-[70vh] min-h-0 border-b border-[#222]">
      <PanelProvider
        sessionId={id}
        projectId="preview"
        projectPath=""
        sessionTitle={title}
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

/** 开发预览：进行中末行「正在思考」，结束后不留思考条目。`?preview=activity` */
export default function ActivityPreview() {
  useEffect(() => {
    useWorkbench.setState({
      profiles: {
        "codex-cli": {
          kind: "codex-cli",
          display_name: "Codex",
          icon: "",
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
    <div className="h-screen w-screen overflow-auto bg-[#0f0f0f] text-[#e8e8e8]">
      <Frame id="activity-live" title="正在思考" status="running" events={liveEvents} />
      <Frame id="activity-done" title="思考已结束" status="completed" events={doneEvents} />
    </div>
  );
}
