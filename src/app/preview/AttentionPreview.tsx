import { useEffect } from "react";

import { CommandMenuHost, OPEN_COMMAND_MENU } from "@/features/command-menu/CommandMenuHost";
import { ChatView } from "@/features/chat/timeline/ChatView";
import { Sidebar } from "@/features/sidebar";
import { useWorkbench } from "@/store";
import type { AgentProfile, Project, Session, SessionEvent, SessionEventBody } from "@/types";

const PROJECT_ID = "attention-preview";

function profile(): AgentProfile {
  return {
    kind: "codex-cli",
    display_name: "Codex",
    icon: "",
    commands: [],
    default_access: null,
    capabilities: {
      supports_slash: false,
      supports_resume: false,
      supports_questions: true,
      supports_tuning: false,
      supports_skills: false,
      changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
    },
  };
}

function project(): Project {
  return {
    id: PROJECT_ID,
    name: "工作台",
    path: "/workspace",
    default_agent: "codex-cli",
    created_at: 1,
    updated_at: 1,
  };
}

function session(id: string, title: string, status: Session["status"], updatedAt: number): Session {
  return {
    id,
    project_id: PROJECT_ID,
    agent: "codex-cli",
    native_id: id,
    title,
    status,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

function event(sessionId: string, id: string, seq: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: sessionId, seq, ts: seq * 1000, ...body };
}

const currentId = "codex-cli:current";
const unreadId = "codex-cli:unread";
const approvalId = "codex-cli:approve";

const sessions = [
  session(unreadId, "回合结束还没看", "completed", 2),
  session(currentId, "当前聊天", "completed", 3),
  session(approvalId, "等你批准", "needs-input", 4),
];

function message(sessionId: string, text: string): SessionEvent[] {
  return [
    event(sessionId, `${sessionId}-user`, 1, { kind: "user-message", text }),
    event(sessionId, `${sessionId}-status`, 2, { kind: "status-changed", status: "completed" }),
  ];
}

const approvalEvents: SessionEvent[] = [
  event(approvalId, "approve-user", 1, { kind: "user-message", text: "跑一下测试。" }),
  event(approvalId, "approve-card", 2, {
    kind: "prompt",
    prompt_id: "approve-card",
    prompt_kind: "approval",
    header: "终端",
    question: "允许运行测试？",
    body: "npm test",
    body_kind: "command",
    options: [
      { id: "accept", label: "允许一次", slot: "primary" },
      { id: "decline", label: "拒绝", slot: "deny" },
    ],
    questions: [],
  }),
  event(approvalId, "approve-status", 3, { kind: "status-changed", status: "needs-input" }),
];

function seedAttentionPreview() {
  useWorkbench.setState({
    ready: true,
    projects: [project()],
    sessions: { [PROJECT_ID]: sessions },
    selectedProjectId: PROJECT_ID,
    activeSessionId: { [PROJECT_ID]: currentId },
    unreadFinishedIds: [unreadId],
    events: {
      [currentId]: message(currentId, "这条先放着。"),
      [unreadId]: message(unreadId, "回合已经结束，还没点开。"),
      [approvalId]: approvalEvents,
    },
    eventsReady: {
      [currentId]: true,
      [unreadId]: true,
      [approvalId]: true,
    },
    profiles: { "codex-cli": profile() },
    installations: [
      {
        kind: "codex-cli",
        display_name: "Codex",
        installed: true,
        version: null,
        latest_version: null,
        update_available: false,
        update_via: null,
        detail: null,
        session_linked: true,
      },
    ],
    async selectSession(projectId, sessionId) {
      useWorkbench.setState((state) => ({
        selectedProjectId: projectId,
        activeSessionId: { ...state.activeSessionId, [projectId]: sessionId },
        draftFocused: { ...state.draftFocused, [projectId]: false },
      }));
    },
  });
}

seedAttentionPreview();

/** 开发预览：`?preview=attention`。`menu=1` 打开命令菜单。 */
export default function AttentionPreview() {
  const activeId = useWorkbench((state) => state.activeSessionId[PROJECT_ID] ?? currentId);
  const session = sessions.find((item) => item.id === activeId) ?? sessions[1];
  const events = useWorkbench((state) => state.events[activeId] ?? []);
  const openMenu = new URLSearchParams(window.location.search).get("menu") === "1";
  useEffect(() => {
    if (!openMenu) return;
    window.dispatchEvent(new Event(OPEN_COMMAND_MENU));
  }, [openMenu]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0f0f0f] text-[#e8e8e8]">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <ChatView session={session} events={events} />
      </main>
      <CommandMenuHost />
    </div>
  );
}
