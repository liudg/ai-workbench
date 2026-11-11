import type { AgentKind, AgentProfile, Project, Session, SessionStatus } from "@/types";
import { useWorkbench } from "@/store";

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

function profile(
  kind: AgentKind,
  name: string,
  icon: string | null,
  monochrome = false,
): AgentProfile {
  const linked = kind === "codex-cli" || kind === "claude-code";
  return {
    kind,
    display_name: name,
    icon,
    icon_monochrome: monochrome,
    commands: [],
    default_access: null,
    capabilities: {
      supports_slash: false,
      supports_resume: false,
      supports_questions: false,
      supports_tuning: false,
      supports_skills: false,
      supports_rename: linked,
      supports_fork: linked,
      supports_archive: kind === "codex-cli",
      supports_delete: linked,
      changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
    },
  };
}

function session(input: {
  projectId?: string;
  native: string;
  agent: AgentKind;
  title: string;
  status?: SessionStatus;
  updatedAt: number;
  archived?: boolean;
}): Session {
  const projectId = input.projectId ?? PROJECT_ID;
  return {
    id: `${input.agent}:${input.native}`,
    project_id: projectId,
    agent: input.agent,
    native_id: input.native,
    title: input.title,
    status: input.status as Session["status"],
    created_at: input.updatedAt - 60_000,
    updated_at: input.updatedAt,
    archived: input.archived,
  };
}

function previewSessions(now: number): Session[] {
  const head: Session[] = [
    session({
      native: "run-recent",
      agent: "codex-cli",
      title: "跑侧栏回归",
      status: "running",
      updatedAt: now,
    }),
    session({
      native: "no-status",
      agent: "claude-code",
      title: "补了一半的说明",
      updatedAt: now - 60_000,
    }),
    session({
      native: "idle-codex",
      agent: "codex-cli",
      title: "整理发布说明",
      status: "completed",
      updatedAt: now - 2 * 60_000,
    }),
    session({
      native: "idle-claude",
      agent: "claude-code",
      title: "看登录页文案",
      status: "completed",
      updatedAt: now - 5 * 60_000,
    }),
    session({
      native: "cursor-stopped",
      agent: "cursor-agent",
      title: "查构建日志",
      status: "stopped",
      updatedAt: now - 20 * 60_000,
    }),
    session({
      native: "codex-failed",
      agent: "codex-cli",
      title: "部署预览失败",
      status: "failed",
      updatedAt: now - 40 * 60_000,
      archived: true,
    }),
    session({
      native: "claude-stopped",
      agent: "claude-code",
      title: "中断了格式化",
      status: "stopped",
      updatedAt: now - 50 * 60_000,
    }),
  ];
  const history = Array.from({ length: 210 }, (_, index) => {
    const agent: AgentKind = index % 2 === 0 ? "codex-cli" : "claude-code";
    return session({
      native: `hist-${index}`,
      agent,
      title: `${TASKS[index % TASKS.length]} · ${index + 1}`,
      status: "completed",
      updatedAt: now - (index + 2) * 60 * 60_000,
    });
  });
  const day = 24 * 60 * 60_000;
  return [
    ...head,
    ...history,
    session({
      native: "wait-delete",
      agent: "claude-code",
      title: "等你确认删除",
      status: "needs-input",
      updatedAt: now - 3 * day,
    }),
    session({
      native: "run-old",
      agent: "codex-cli",
      title: "还在改虚拟列表",
      status: "running",
      updatedAt: now - 4 * day,
    }),
  ];
}

const projects: Project[] = [
  {
    id: PROJECT_ID,
    name: "cli-agents",
    path: "/work/cli-agents",
    default_agent: "codex-cli",
    created_at: 1,
    updated_at: 2,
  },
  {
    id: NOTES_ID,
    name: "notes",
    path: "/work/notes",
    default_agent: "claude-code",
    created_at: 1,
    updated_at: 1,
  },
];

function mapPreviewSession(
  groups: Record<string, Session[]>,
  sessionId: string,
  update: (session: Session) => Session | null,
): Record<string, Session[]> {
  const next: Record<string, Session[]> = {};
  for (const [projectId, list] of Object.entries(groups)) {
    next[projectId] = list.flatMap((session) => {
      if (session.id !== sessionId) return [session];
      const updated = update(session);
      return updated ? [updated] : [];
    });
  }
  return next;
}

/** 开发预览。只从 DEV 入口加载，不进安装包。 */
export function seedSidebarPreview() {
  const now = Date.now();
  useWorkbench.setState({
    projects,
    sessions: {
      [PROJECT_ID]: previewSessions(now),
      [NOTES_ID]: [
        session({
          projectId: NOTES_ID,
          native: "note-idle",
          agent: "codex-cli",
          title: "记一下接口",
          status: "completed",
          updatedAt: now - 10 * 60_000,
        }),
        session({
          projectId: NOTES_ID,
          native: "note-run",
          agent: "claude-code",
          title: "还在写纪要",
          status: "running",
          updatedAt: now - 8 * 60_000,
        }),
        session({
          projectId: NOTES_ID,
          native: "note-kimi",
          agent: "kimi-code",
          title: "Kimi",
          status: "completed",
          updatedAt: now - 12 * 60_000,
        }),
        session({
          projectId: NOTES_ID,
          native: "note-qwen",
          agent: "qwen-code",
          title: "Qwen",
          status: "completed",
          updatedAt: now - 13 * 60_000,
        }),
        session({
          projectId: NOTES_ID,
          native: "note-open",
          agent: "opencode",
          title: "OpenCode",
          status: "completed",
          updatedAt: now - 14 * 60_000,
        }),
        session({
          projectId: NOTES_ID,
          native: "note-anti",
          agent: "antigravity",
          title: "Antigravity",
          status: "completed",
          updatedAt: now - 15 * 60_000,
        }),
      ],
    },
    // 只给开发预览用，不进安装包。新建菜单需要两份可开会话的 Agent 才能对上位置。
    installations: [
      {
        kind: "codex-cli",
        display_name: "Codex CLI",
        installed: true,
        version: null,
        latest_version: null,
        update_available: false,
        update_via: null,
        detail: null,
        session_linked: true,
      },
      {
        kind: "claude-code",
        display_name: "Claude Code",
        installed: true,
        version: null,
        latest_version: null,
        update_available: false,
        update_via: null,
        detail: null,
        session_linked: true,
      },
    ],
    installationsLoading: false,
    profiles: {
      "codex-cli": profile("codex-cli", "Codex CLI", "/agent-icons/codex.svg", true),
      "claude-code": profile("claude-code", "Claude Code", "/agent-icons/claude.svg", false),
      "cursor-agent": profile("cursor-agent", "Cursor Agent", "/agent-icons/cursor-agent.svg", true),
      "kimi-code": profile("kimi-code", "Kimi Code", "/agent-icons/kimi-code.svg", true),
      "qwen-code": profile("qwen-code", "Qwen Code", "/agent-icons/qwen-code.svg", false),
      "opencode": profile("opencode", "OpenCode", "/agent-icons/opencode.svg", true),
      antigravity: profile("antigravity", "Antigravity", "/agent-icons/antigravity.svg", false),
    },
    selectedProjectId: PROJECT_ID,
    activeSessionId: { [PROJECT_ID]: "claude-code:idle-claude" },
    sidebarNotice: null,
    lifecycleBusy: null,
    async selectProject(id) {
      useWorkbench.setState({ selectedProjectId: id });
    },
    async selectSession(projectId, sessionId) {
      useWorkbench.setState((state) => ({
        selectedProjectId: projectId,
        activeSessionId: { ...state.activeSessionId, [projectId]: sessionId },
        draftFocused: { ...(state.draftFocused ?? {}), [projectId]: false },
      }));
    },
    async createSession() {
      return null;
    },
    async updateProject(input) {
      useWorkbench.setState((state) => ({
        projects: state.projects.map((project) =>
          project.id === input.id
            ? {
                ...project,
                name: input.name.trim(),
                path: input.folders[0] ?? project.path,
                folders: input.folders,
              }
            : project,
        ),
      }));
    },
    async removeProject() {},
    async renameSession(sessionId, name) {
      const title = name.trim();
      if (!title) return false;
      useWorkbench.setState((state) => ({
        sessions: mapPreviewSession(state.sessions, sessionId, (session) => ({
          ...session,
          title,
        })),
      }));
      return true;
    },
    async forkSession() {},
    async archiveSession(_projectId, sessionId, archived) {
      useWorkbench.setState((state) => ({
        sessions: mapPreviewSession(state.sessions, sessionId, (session) => ({
          ...session,
          archived,
        })),
      }));
      return true;
    },
    async deleteSession(projectId, sessionId) {
      useWorkbench.setState((state) => {
        const activeSessionId = { ...state.activeSessionId };
        if (activeSessionId[projectId] === sessionId) delete activeSessionId[projectId];
        return {
          sessions: mapPreviewSession(state.sessions, sessionId, () => null),
          activeSessionId,
        };
      });
      return true;
    },
  });
}
