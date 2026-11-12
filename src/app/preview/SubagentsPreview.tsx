import type { Session, SessionEvent, SessionEventBody } from "@/types";
import { PreviewSession } from "./PreviewSession";

const sessionId = "subagents-preview";

const SESSION: Session = {
  id: sessionId,
  project_id: "preview",
  agent: "claude-code",
  native_id: sessionId,
  title: "子 Agent",
  status: "completed",
  created_at: 1,
  updated_at: 1,
};

const now = Date.now();

function event(id: string, seq: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: sessionId, seq, ts: now - (40 - seq) * 1_000, ...body };
}

function step(id: string, seq: number, subagent: string, body: SessionEventBody): SessionEvent {
  return event(id, seq, { kind: "subagent-step", subagent_id: subagent, step: body });
}

// 形状照 Claude Code 2.1.312 实录：并行派两个前台子 Agent，再派一个后台的。
const events: SessionEvent[] = [
  event("u1", 1, { kind: "user-message", text: "并行派两个子 Agent：一个跑 echo PING，一个不用工具只回 PONG。" }),
  event("c1", 2, {
    kind: "subagent",
    subagent_id: "toolu_ping",
    title: "Run echo PING",
    agent_type: "general-purpose",
    model: "claude-haiku-5-5",
    prompt: "Run the shell command `echo PING` using your shell tool and reply with its output exactly.",
    status: "completed",
    result: "PING",
    tokens: 36222,
    tool_uses: 1,
    duration_ms: 8251,
    started_at: now - 38_000,
    ended_at: now - 30_000,
  }),
  step("p1", 3, "toolu_ping", { kind: "tool-call", name: "command", summary: "echo PING", detail: "PING", status: "completed" }),
  step("p2", 4, "toolu_ping", { kind: "agent-message", text: "PING", phase: "final-answer" }),
  event("c2", 5, {
    kind: "subagent",
    subagent_id: "toolu_pong",
    title: "Reply PONG without tools",
    agent_type: "general-purpose",
    model: "claude-haiku-5-5",
    prompt: "Reply with just the word PONG. Do not use any tools.",
    status: "completed",
    result: "PONG",
    tokens: 33752,
    duration_ms: 5513,
    started_at: now - 37_000,
    ended_at: now - 32_000,
  }),
  step("q1", 6, "toolu_pong", { kind: "agent-message", text: "PONG", phase: "final-answer" }),
  event("a1", 7, {
    kind: "agent-message",
    text: "两个子 Agent 都完成了：\n\n- 跑命令的：`PING`\n- 不用工具的：`PONG`",
    phase: "final-answer",
  }),
  event("s1", 8, { kind: "status-changed", status: "completed" }),
  event("u2", 9, { kind: "user-message", text: "再派一个后台子 Agent 跑 `sleep 30 && echo BG`，不用等。" }),
  event("c3", 10, {
    kind: "subagent",
    subagent_id: "toolu_bg",
    title: "Run background sleep echo",
    agent_type: "general-purpose",
    model: "claude-haiku-5-5",
    prompt: "Run the shell command `sleep 30 && echo BG` using the shell tool, then reply with the output.",
    status: "running",
    background: true,
    activity: "Running Sleep 30 seconds then echo BG",
    tool_uses: 1,
    started_at: now - 12_000,
  }),
  step("b1", 11, "toolu_bg", {
    kind: "tool-call",
    name: "command",
    summary: "sleep 30 && echo BG",
    status: "running",
  }),
  event("a2", 12, { kind: "agent-message", text: "已在后台派出，跑完会告诉你。", phase: "final-answer" }),
  event("s2", 13, { kind: "status-changed", status: "completed" }),
];

/** 开发预览：Agent 自带的子 Agent 卡片。`?preview=subagents` */
export default function SubagentsPreview() {
  return (
    <div className="h-screen w-screen bg-wb-surface text-wb-fg">
      <PreviewSession session={SESSION} events={events} panel={false} />
    </div>
  );
}
