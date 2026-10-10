// 全局状态（zustand）：项目 / 会话 / 事件日志 + 与后端的双向同步。
//
// 同步策略：
// - 结构变化（项目增删、会话创建、状态变化、标题变化）→ 后端广播
//   projects-changed / sessions-changed，前端重拉对应列表；
// - 高频流式内容 → session-event 单条增量推送，按 id 去重合并。

import { create } from "zustand";

import type { Project, Session, SessionEvent } from "@/types";
import {
  backend,
  type CreateProjectInput,
  type ImportProjectInput,
} from "@/lib/ipc";
import {
  checkForUpdate,
  installUpdate,
  type UpdatePhase,
} from "@/lib/updater";

export type DialogMode = "create" | "import";

interface WorkbenchState {
  ready: boolean;
  projects: Project[];
  sessions: Record<string, Session[]>;
  events: Record<string, SessionEvent[]>;
  selectedProjectId: string | null;
  activeSessionId: Record<string, string>;
  dialog: DialogMode | null;
  /** 最近一次操作错误（对话框 / 状态栏展示） */
  lastError: string | null;

  /** 应用更新状态 */
  update: UpdatePhase;
  updateDialogOpen: boolean;

  init(): Promise<void>;
  openDialog(mode: DialogMode): void;
  closeDialog(): void;
  clearError(): void;

  /** 检查更新；manual=true 时无论结果都弹出对话框，自动检查仅在有更新时弹出 */
  checkUpdates(manual: boolean): Promise<void>;
  startInstall(): Promise<void>;
  closeUpdateDialog(): void;

  selectProject(id: string): Promise<void>;
  createProject(input: CreateProjectInput): Promise<string | null>;
  importProject(input: ImportProjectInput): Promise<void>;
  removeProject(id: string): Promise<void>;

  createSession(projectId: string): Promise<void>;
  selectSession(projectId: string, sessionId: string): Promise<void>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  answerPrompt(sessionId: string, promptId: string, answer: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
}

async function loadSessions(
  projectId: string,
): Promise<[string, Session[]]> {
  return [projectId, await backend.listSessions(projectId)];
}

// React StrictMode 下 effect 会执行两次，事件订阅只需一次
let initStarted = false;

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  ready: false,
  projects: [],
  sessions: {},
  events: {},
  selectedProjectId: null,
  activeSessionId: {},
  dialog: null,
  lastError: null,
  update: { kind: "idle" },
  updateDialogOpen: false,

  async init() {
    if (initStarted) return;
    initStarted = true;
    backend.onSessionEvent((event) => {
      set((s) => {
        const log = s.events[event.session_id] ?? [];
        if (log.some((e) => e.id === event.id)) return s;
        return {
          events: {
            ...s.events,
            [event.session_id]: [...log, event],
          },
        };
      });
    });
    backend.onSessionsChanged((projectId) => {
      loadSessions(projectId).then(([pid, list]) =>
        set((s) => ({ sessions: { ...s.sessions, [pid]: list } })),
      );
    });
    backend.onProjectsChanged(() => {
      backend.listProjects().then((projects) => set({ projects }));
    });

    const projects = await backend.listProjects();
    set({ projects, ready: true });
    if (projects.length > 0) {
      await get().selectProject(projects[0].id);
    }
    // 启动后静默检查更新：失败不打扰，有更新才弹窗
    get().checkUpdates(false);
  },

  async checkUpdates(manual) {
    if (manual) {
      set({ updateDialogOpen: true, update: { kind: "checking" } });
    }
    await checkForUpdate((phase) => {
      set((s) => {
        // 手动检查期间已被更新的状态（如下载中）覆盖时，不回退
        if (
          s.update.kind === "downloading" &&
          (phase.kind === "checking" || phase.kind === "available")
        ) {
          return s;
        }
        const next: Partial<WorkbenchState> = { update: phase };
        // 自动检查：仅发现新版本时弹窗；其余结果静默
        if (!manual && phase.kind === "available") {
          next.updateDialogOpen = true;
        }
        return next;
      });
    });
    // 手动检查时若失败/无更新，状态已由 onPhase 呈现；无需额外处理
  },

  async startInstall() {
    await installUpdate((phase) => set({ update: phase }));
  },

  closeUpdateDialog() {
    set({ updateDialogOpen: false });
  },

  openDialog: (mode) => set({ dialog: mode, lastError: null }),
  closeDialog: () => set({ dialog: null, lastError: null }),
  clearError: () => set({ lastError: null }),

  async selectProject(id) {
    set({ selectedProjectId: id });
    if (!get().sessions[id]) {
      const [pid, list] = await loadSessions(id);
      set((s) => ({ sessions: { ...s.sessions, [pid]: list } }));
    }
    const activeId = get().activeSessionId[id];
    if (activeId && !get().events[activeId]) {
      const events = await backend.getSessionEvents(activeId);
      set((s) => ({ events: { ...s.events, [activeId]: events } }));
    }
  },

  // 注意：项目列表以后端重拉为唯一数据源（projects-changed 广播也会触发重拉），
  // 不在本地手动 append，避免广播与本地写入竞态造成重复。

  async createProject(input) {
    try {
      const result = await backend.createProject(input);
      const projects = await backend.listProjects();
      set({ projects, dialog: null });
      await get().selectProject(result.project.id);
      return result.warning;
    } catch (e) {
      set({ lastError: String(e) });
      return null;
    }
  },

  async importProject(input) {
    try {
      const project = await backend.importProject(input);
      const projects = await backend.listProjects();
      set({ projects, dialog: null });
      await get().selectProject(project.id);
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  async removeProject(id) {
    await backend.removeProject(id);
    const projects = await backend.listProjects();
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      const selectedProjectId =
        s.selectedProjectId === id
          ? (projects[0]?.id ?? null)
          : s.selectedProjectId;
      return { projects, sessions, selectedProjectId };
    });
    const next = get().selectedProjectId;
    if (next) await get().selectProject(next);
  },

  async createSession(projectId) {
    try {
      const session = await backend.createSession(projectId);
      const [, list] = await loadSessions(projectId);
      set((s) => ({
        sessions: { ...s.sessions, [projectId]: list },
        activeSessionId: { ...s.activeSessionId, [projectId]: session.id },
        events: { ...s.events, [session.id]: s.events[session.id] ?? [] },
      }));
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  async selectSession(projectId, sessionId) {
    set((s) => ({
      activeSessionId: { ...s.activeSessionId, [projectId]: sessionId },
    }));
    if (!get().events[sessionId]) {
      const events = await backend.getSessionEvents(sessionId);
      set((s) => ({ events: { ...s.events, [sessionId]: events } }));
    }
  },

  async sendMessage(sessionId, text) {
    try {
      await backend.sendMessage(sessionId, text);
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  async answerPrompt(sessionId, promptId, answer) {
    try {
      await backend.answerPrompt(sessionId, promptId, answer);
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  async stopSession(sessionId) {
    try {
      await backend.stopSession(sessionId);
    } catch (e) {
      set({ lastError: String(e) });
    }
  },
}));
