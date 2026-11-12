import type { SubtaskHost } from "@/features/chat";
import type { Session, SessionEvent, SessionEventBody } from "@/types";
import { PreviewSession } from "./PreviewSession";

const sessionId = "nested-session-preview";

const SESSION: Session = {
  id: sessionId,
  project_id: "preview",
  agent: "codex-cli",
  native_id: sessionId,
  title: "排查工作台数据库 event 表损坏",
  status: "completed",
  created_at: 1,
  updated_at: 1,
};

function event(id: string, seq: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: sessionId, seq, ts: Date.now() - (5 * 60 - seq) * 60_000, ...body };
}

const PROMPT = [
  "排查本机工作台数据库的损坏原因，并给出恢复方案。",
  "先确认损坏范围：哪些表受影响、最早出现的时间、当时 daemon 在做什么。",
  "再给出恢复步骤和数据损失评估，恢复动作执行前先问用户。",
  "完成标准：写清原因、证据和可执行的恢复步骤。",
  "不要改动现有数据库文件，所有实验都在副本上做。",
].join("\n\n");

const CONTEXT =
  "AI Workbench 是 Tauri + React 的多 Agent 桌面工作台，后台 daemon 持有 SQLite，时间线事件都存在 `event` 表。\n\n这个损坏是在排查另一个问题时，用只读连接和一份运行中复制的副本发现的，两者结果一致，但尚未排除副本和并发发写的影响。";

const events: SessionEvent[] = [
  event("u1", 1, {
    kind: "user-message",
    text: PROMPT,
    sender: {
      task_ids: ["origin"],
      background: CONTEXT,
      notes: "C:\\Users\\me\\AppData\\Roaming\\com.aiworkbench.app\\session-notes\\origin",
    },
  }),
  event("a1", 2, { kind: "agent-message", text: "我先用只读连接看一下损坏范围。", phase: "final-answer" }),
  event("s1", 3, { kind: "status-changed", status: "completed" }),
];

const SUBTASKS: SubtaskHost = {
  title: () => "嵌套会话指令问题分析",
  agent: () => "claude-code",
  useSubtask: () => undefined,
  open: () => {},
  resolveOffer: async () => {},
};

/** 开发预览：Agent 开的会话的信息流头部。`?preview=nested-session` */
export default function NestedSessionPreview() {
  return (
    <div className="h-screen w-screen bg-wb-surface text-wb-fg">
      <PreviewSession session={SESSION} events={events} subtasks={SUBTASKS} panel={false} />
    </div>
  );
}
