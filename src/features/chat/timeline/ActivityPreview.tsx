import { useEffect } from "react";

import { useWorkbench } from "@/store";
import { AnswerMarkdownHost } from "@/features/workspace/AnswerMarkdownHost";
import { PanelProvider } from "@/features/panel/core/PanelProvider";
import { SessionSplit } from "@/features/panel/core/SessionSplit";
import { ChatView } from "@/features/chat/timeline/ChatView";
import type { Session, SessionEvent, SessionEventBody } from "@/types";

const SESSION_ID = "activity-preview";

function session(): Session {
  return {
    id: SESSION_ID,
    project_id: "preview",
    agent: "codex-cli",
    native_id: SESSION_ID,
    title: "聊天活动时间线",
    status: "running",
    created_at: 1,
    updated_at: 1,
  };
}

function event(id: string, seq: number, ts: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: SESSION_ID, seq, ts, ...body };
}

const events: SessionEvent[] = [
  event("user", 1, 1_000, { kind: "user-message", text: "验收链接里标记已修复的缺陷。" }),
  event("narration", 2, 2_000, {
    kind: "agent-message",
    phase: "commentary",
    text: "我已经查看了当前页面的缺陷表格，并通过 Chrome 和 Unitymcp 集成执行了相关操作。\n\n当前表格中有一个缺陷记录被选中。我检查了选中状态，查看了可用的表格复制操作，并成功复制了选中的缺陷记录（只读模式），以便进一步使用或验证。",
  }),
  event("think-1", 3, 3_000, { kind: "thinking", text: "先核对表格选区。" }),
  event("mcp-chrome", 4, 4_000, {
    kind: "tool-call",
    name: "browser_snapshot",
    summary: "MCP Chrome browser_snapshot",
  }),
  event("mcp-unity", 5, 5_000, {
    kind: "tool-call",
    name: "execute_code",
    summary: "MCP Unitymcp execute_code",
  }),
  // 第二条思考只拆开后面的命令，界面仍只留一条思考。
  event("think-2", 6, 6_000, { kind: "thinking", text: "再看复制操作。" }),
  event("cmd-1", 7, 7_000, { kind: "tool-call", name: "command", summary: "检查了表格选中" }),
  event("cmd-2", 8, 8_000, { kind: "tool-call", name: "command", summary: "查看了表格复制操作" }),
  event("cmd-3", 9, 9_000, {
    kind: "tool-call",
    name: "command",
    summary: "复制了缺陷记录选中（只读）",
  }),
  event("status", 10, 9_100, { kind: "status-changed", status: "running" }),
];

/** 开发预览：相邻工具收成一行，思考只留一条。`?preview=activity` */
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
  const current = session();
  return (
    <div className="h-screen w-screen overflow-hidden bg-[#0f0f0f] text-[#e8e8e8]">
      <PanelProvider
        sessionId={SESSION_ID}
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
