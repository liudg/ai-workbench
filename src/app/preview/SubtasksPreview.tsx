import type { SubtaskHost } from "@/features/chat/host";
import type { Session, SessionEvent, SessionEventBody } from "@/types";
import { PreviewSession } from "./PreviewSession";

const sessionId = "subtasks-preview";

const SESSION: Session = {
  id: sessionId,
  project_id: "preview",
  agent: "claude-code",
  native_id: sessionId,
  title: "登录页",
  status: "completed",
  created_at: 1,
  updated_at: 1,
};

function event(id: string, seq: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: sessionId, seq, ts: Date.now() - (20 - seq) * 60_000, ...body };
}

const TITLES: Record<string, string> = { "sub-write": "改登录页文案", "sub-test": "补登录页测试" };

const events: SessionEvent[] = [
  event("u1", 1, { kind: "user-message", text: "把登录页文案改了，另开两个子任务并行做，测试交给 Claude。" }),
  event("a1", 2, { kind: "agent-message", text: "已开出两个子任务，跑完我再看结果。", phase: "final-answer" }),
  event("s1", 3, { kind: "status-changed", status: "completed" }),
  event("r1", 4, {
    kind: "user-message",
    text: "Subtasks have new results.\n\n## 改登录页文案\ntaskId: sub-write\nstate: done\nbranch: aiwb/login-copy\nlast answer:\n改好了三处文案。",
    sender: { task_ids: ["sub-write", "sub-test"] },
  }),
  event("a2", 5, { kind: "agent-message", text: "两个子任务都完成了。我先看一下 diff 再告诉你。", phase: "final-answer" }),
  event("o1", 6, {
    kind: "subtask-offer",
    offer_id: "offer-1",
    initiation: "offer",
    subtasks: [
      { agent: "codex-cli", title: "修注册页", prompt: "注册页的提交按钮在窄屏下被遮住，修好并补一条截图测试。", worktree: true },
    ],
  }),
  event("o2", 7, {
    kind: "subtask-offer",
    offer_id: "offer-2",
    initiation: "own_initiative",
    subtasks: [{ agent: "claude-code", title: "清理旧样式", prompt: "删掉 login.css 里不再用的选择器。" }],
    resolution: { kind: "accepted", task_ids: ["sub-test"] },
  }),
  event("s2", 8, { kind: "status-changed", status: "completed" }),
];

const SUBTASKS: SubtaskHost = {
  title: (taskId) => TITLES[taskId],
  open: () => {},
  resolveOffer: async () => {},
};

/** 开发预览：子任务回报折成一行，开子任务的卡片。`?preview=subtasks` */
export default function SubtasksPreview() {
  return (
    <div className="h-screen w-screen bg-[#0f0f0f] text-[#e8e8e8]">
      <PreviewSession session={SESSION} events={events} subtasks={SUBTASKS} panel={false} />
    </div>
  );
}
