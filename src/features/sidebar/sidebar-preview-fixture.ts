// 开发样例页的侧栏数据。只从 DEV 入口加载，不进安装包。不连 daemon，动作都不会生效。

import { seedAgents } from "@/features/agents";
import type { Project } from "@/features/projects";
import type { TaskEntry } from "@/features/tasks";
import { startPreview, TOPIC_PROJECTS, TOPIC_TASKS } from "@/lib/daemon";
import type { Attention } from "@/shared/attention";
import { openTask } from "@/shared/shell/navigation";
import type { AgentInstallation, AgentKind, AgentProfile, SessionStatus } from "@/types";

const PROJECT_ID = "preview-project";
const NOTES_ID = "preview-notes";

const TASKS = [
  "修登录跳转",
  "补权限说明",
  "看差分高亮",
  "整理会话标题",
  "查构建失败",
  "改预览滚动",
  "对齐状态点",
  "收起文件树",
  "核对更新弹窗",
  "补图标资源",
];

function profile(kind: AgentKind, name: string, icon: string | null, monochrome = false): AgentProfile {
  return {
    kind,
    display_name: name,
    icon,
    monochrome_icon: monochrome,
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
  };
}

function installation(kind: AgentKind, name: string): AgentInstallation {
  return {
    kind,
    display_name: name,
    installed: true,
    version: null,
    latest_version: null,
    update_available: false,
    update_via: null,
    detail: null,
    session_linked: true,
  };
}

function task(input: {
  projectId?: string;
  id: string;
  agent: AgentKind;
  title: string;
  status?: SessionStatus;
  updatedAt: number;
  archived?: boolean;
  pinned?: boolean;
  unread?: boolean;
  ask?: Attention["ask"];
}): TaskEntry {
  const projectId = input.projectId ?? PROJECT_ID;
  const status = input.status ?? "completed";
  return {
    id: input.id,
    projectId,
    title: input.title,
    workspace: { kind: "root" },
    pinned: Boolean(input.pinned),
    archivedAt: input.archived ? input.updatedAt : undefined,
    createdAt: input.updatedAt - 60_000,
    updatedAt: input.updatedAt,
    sessions: [
      {
        id: `${input.id}-s`,
        taskId: input.id,
        agent: input.agent,
        status,
        options: {},
        createdAt: input.updatedAt - 60_000,
        updatedAt: input.updatedAt,
      },
    ],
    attention: {
      state: ATTENTION_STATE[status],
      unread: Boolean(input.unread),
      ask: input.ask,
      updatedAt: input.updatedAt,
    },
  };
}

const ATTENTION_STATE: Record<SessionStatus, Attention["state"]> = {
  starting: "starting",
  idle: "new",
  running: "working",
  "needs-input": "needs-input",
  completed: "done",
  failed: "failed",
  stopped: "idle",
};

function previewTasks(now: number): TaskEntry[] {
  const day = 24 * 60 * 60_000;
  const head = [
    task({ id: "run-recent", agent: "codex-cli", title: "跑侧栏回归", status: "running", updatedAt: now }),
    task({ id: "pinned", agent: "claude-code", title: "补了一半的说明", updatedAt: now - 60_000, pinned: true }),
    task({ id: "idle-codex", agent: "codex-cli", title: "整理发布说明", updatedAt: now - 2 * 60_000, unread: true }),
    task({ id: "idle-claude", agent: "claude-code", title: "看登录页文案", updatedAt: now - 5 * 60_000 }),
    {
      ...task({ id: "sub-write", agent: "codex-cli", title: "改登录页文案", status: "running", updatedAt: now - 3 * 60_000 }),
      parentTaskId: "idle-claude",
    },
    {
      ...task({ id: "sub-test", agent: "claude-code", title: "补登录页测试", updatedAt: now - 4 * 60_000 }),
      parentTaskId: "idle-claude",
    },
    task({ id: "codex-stopped", agent: "codex-cli", title: "查构建日志", status: "stopped", updatedAt: now - 20 * 60_000 }),
    task({
      id: "codex-failed",
      agent: "codex-cli",
      title: "部署预览失败",
      status: "failed",
      updatedAt: now - 40 * 60_000,
      archived: true,
    }),
    task({
      id: "claude-failed",
      agent: "claude-code",
      title: "中断了格式化",
      status: "failed",
      updatedAt: now - 50 * 60_000,
      unread: true,
    }),
  ];
  const history = Array.from({ length: 210 }, (_, index) =>
    task({
      id: `hist-${index}`,
      agent: index % 2 === 0 ? "codex-cli" : "claude-code",
      title: `${TASKS[index % TASKS.length]} · ${index + 1}`,
      updatedAt: now - (index + 2) * 60 * 60_000,
    }),
  );
  const notes = [
    task({ projectId: NOTES_ID, id: "note-idle", agent: "codex-cli", title: "记一下接口", updatedAt: now - 10 * 60_000 }),
    task({
      projectId: NOTES_ID,
      id: "note-run",
      agent: "claude-code",
      title: "还在写纪要",
      status: "running",
      updatedAt: now - 8 * 60_000,
    }),
  ];
  const chats = [
    { ...task({ id: "chat-1", agent: "codex-cli", title: "随手问一句", updatedAt: now - 30 * 60_000 }), projectId: undefined },
  ];
  return [
    ...head,
    ...history,
    task({
      id: "wait-delete",
      agent: "claude-code",
      title: "等你确认删除",
      status: "needs-input",
      ask: "approval",
      updatedAt: now - 3 * day,
    }),
    task({ id: "run-old", agent: "codex-cli", title: "还在改虚拟列表", status: "running", updatedAt: now - 4 * day }),
    ...notes,
    ...chats,
  ];
}

const projects: Project[] = [
  { id: PROJECT_ID, name: "cli-agents", path: "/work/cli-agents", folders: ["/work/cli-agents"], pinned: false, createdAt: 1, updatedAt: 2 },
  { id: NOTES_ID, name: "notes", path: "/work/notes", folders: ["/work/notes"], pinned: true, createdAt: 1, updatedAt: 1 },
];

export function seedSidebarPreview() {
  startPreview({ [TOPIC_PROJECTS]: projects, [TOPIC_TASKS]: previewTasks(Date.now()) });
  seedAgents(
    {
      "codex-cli": profile("codex-cli", "Codex CLI", "/agent-icons/codex.svg", true),
      "claude-code": profile("claude-code", "Claude Code", "/agent-icons/claude.svg"),
    },
    [installation("codex-cli", "Codex CLI"), installation("claude-code", "Claude Code")],
  );
  openTask("idle-claude", PROJECT_ID);
}
