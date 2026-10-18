import { useEffect } from "react";

import { OPEN_THREAD_FIND } from "@/features/chat/find/use-thread-find";
import { ChatView } from "@/features/chat/timeline/ChatView";
import type { Session, SessionEvent, SessionEventBody, SessionStatus } from "@/types";

import { useActivityPreviewProfiles } from "./use-activity-preview";

function session(status: SessionStatus): Session {
  return {
    id: "find-preview",
    project_id: "preview",
    agent: "codex-cli",
    native_id: "find-preview",
    title: "会话内查找",
    status,
    created_at: 1,
    updated_at: 1,
  };
}

function event(id: string, seq: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: "find-preview", seq, ts: seq * 1000, ...body };
}

const events: SessionEvent[] = [
  event("user", 1, { kind: "user-message", text: "请把装备对比提示的颜色改醒目一点。" }),
  event("answer", 2, {
    kind: "agent-message",
    phase: "final-answer",
    text: "装备对比的评分颜色、箭头和替换按钮都已经调过。普通详情入口保持原样。",
  }),
  event("note", 3, { kind: "system", text: "这轮改动只在当前聊天里。" }),
  event("status", 4, { kind: "status-changed", status: "completed" }),
];

/** 开发预览：`?preview=thread-find&q=装备`。`q` 预填查找。 */
export default function ThreadFindPreview() {
  useActivityPreviewProfiles();
  const query = new URLSearchParams(window.location.search).get("q") ?? "装备";
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(OPEN_THREAD_FIND, { detail: { query } }));
  }, [query]);

  return (
    <div className="relative flex h-screen min-h-0 flex-col bg-[#0f0f0f] text-[#e8e8e8]">
      <ChatView session={session("completed")} events={events} />
    </div>
  );
}
