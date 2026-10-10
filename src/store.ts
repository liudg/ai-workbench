// 全局状态（zustand）：项目 / 会话 / 事件日志 + 与后端的双向同步。
//
// 同步策略：
// - 结构变化（项目增删、会话创建、状态变化、标题变化）→ 后端广播
//   projects-changed / sessions-changed，前端重拉对应列表；
// - 高频流式内容 → session-event 单条增量推送，按 id 去重合并。

import { create } from "zustand";

import {
  emptyCatalog,
  type AccessMode,
  type AgentCatalog,
  type AgentKind,
  type AgentProfile,
  type Attachment,
  type Project,
  type PromptAnswer,
  type Session,
  type SessionEvent,
} from "@/types";
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
import { isReadOnlyOpen } from "@/lib/utils";

const MISSING_SESSION = "会话不存在或已结束";

function clearMissingSessionBanner(
  lastError: string | null,
  events: { kind: string }[],
): string | null {
  if (lastError === MISSING_SESSION && isReadOnlyOpen(events)) return null;
  return lastError;
}

export type DialogMode = "create" | "import";

interface WorkbenchState {
  ready: boolean;
  projects: Project[];
  sessions: Record<string, Session[]>;
  events: Record<string, SessionEvent[]>;
  selectedProjectId: string | null;
  activeSessionId: Record<string, string>;
  /** 顶部标签只放打开过的会话，侧边栏才是完整 resume 列表。 */
  openedSessionIds: Record<string, string[]>;
  dialog: DialogMode | null;
  /** 最近一次操作错误（对话框 / 状态栏展示） */
  lastError: string | null;

  /** 应用更新状态 */
  update: UpdatePhase;
  updateDialogOpen: boolean;

  /** 下次新建会话默认选中的 Agent */
  preferredAgent: AgentKind;
  /** 前端覆盖的会话 Agent，并回写后端 */
  agentOverride: Record<string, AgentKind>;
  /** 每个会话的权限档位，新建会话继承上一档 */
  lastAccessMode: AccessMode;
  accessMode: Record<string, AccessMode>;
  attachments: Record<string, Attachment[]>;
  profiles: Partial<Record<AgentKind, AgentProfile>>;
  catalogs: Record<string, AgentCatalog>;
  tuning: Record<string, { model: string; effort: string }>;
  /** 点消息上的编辑后，把原文填回输入框 */
  composerSeed: { sessionId: string; text: string; token: number } | null;

  init(): Promise<void>;
  refreshAll(): Promise<void>;
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

  createSession(projectId: string, agent: AgentKind): Promise<void>;
  setSessionAgent(sessionId: string, agent: AgentKind): void;
  setAccessMode(sessionId: string, mode: AccessMode): void;
  loadCatalog(sessionId: string): Promise<void>;
  setTuning(sessionId: string, model: string, effort: string): void;
  addAttachments(sessionId: string, files: Attachment[]): void;
  removeAttachment(sessionId: string, path: string): void;
  clearAttachments(sessionId: string): void;
  selectSession(projectId: string, sessionId: string): Promise<void>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  seedComposer(sessionId: string, text: string): void;
  answerPrompt(sessionId: string, promptId: string, answer: PromptAnswer): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
}

function mergeEvents(
  local: SessionEvent[] | undefined,
  remote: SessionEvent[],
): SessionEvent[] {
  const map = new Map<string, SessionEvent>();
  for (const event of remote) map.set(event.id, event);
  for (const event of local ?? []) map.set(event.id, event);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

function stampAgents(list: Session[]): Session[] {
  const overrides = useWorkbench.getState().agentOverride;
  return list.map((session) =>
    overrides[session.id]
      ? { ...session, agent: overrides[session.id] }
      : session,
  );
}

async function loadSessions(
  projectId: string,
): Promise<[string, Session[]]> {
  return [projectId, stampAgents(await backend.listSessions(projectId))];
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
  openedSessionIds: {},
  dialog: null,
  lastError: null,
  update: { kind: "idle" },
  updateDialogOpen: false,
  preferredAgent: "codex-cli",
  agentOverride: {},
  lastAccessMode: "full",
  accessMode: {},
  attachments: {},
  profiles: {},
  catalogs: {},
  tuning: {},
  composerSeed: null,

  async init() {
    if (initStarted) return;
    initStarted = true;
    backend.onSessionEvent((event) => {
      set((s) => {
        const log = s.events[event.session_id] ?? [];
        const index = log.findIndex((item) => item.id === event.id);
        const next =
          index >= 0
            ? log.map((item, i) => (i === index ? event : item))
            : [...log, event];
        return {
          events: {
            ...s.events,
            [event.session_id]: next,
          },
          lastError: clearMissingSessionBanner(s.lastError, next),
        };
      });
    });
    backend.onSessionsChanged((projectId) => {
      loadSessions(projectId).then(([pid, list]) =>
        set((s) => ({ sessions: { ...s.sessions, [pid]: list } })),
      );
    });
    backend.onProjectsChanged(() => {
      backend.listProjects().then(async (projects) => {
        const pairs = await Promise.all(projects.map((p) => loadSessions(p.id)));
        set((s) => {
          const sessions = { ...s.sessions };
          for (const [pid, list] of pairs) sessions[pid] = list;
          return { projects, sessions };
        });
      });
    });

    try {
      const profiles = await backend.agentProfiles();
      set({
        profiles: Object.fromEntries(profiles.map((profile) => [profile.kind, profile])),
      });
    } catch (e) {
      set({ lastError: String(e) });
    }
    await get().refreshAll();
    const first = get().projects[0]?.id;
    if (first) await get().selectProject(first);
    window.setInterval(() => {
      void get().refreshAll();
    }, 20_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void get().refreshAll();
    });
    // 启动后静默检查更新：失败不打扰，有更新才弹窗
    get().checkUpdates(false);
  },

  async refreshAll() {
    const projects = await backend.listProjects();
    const pairs = await Promise.all(projects.map((p) => loadSessions(p.id)));
    set((s) => {
      const sessions = { ...s.sessions };
      const ids = new Set(projects.map((project) => project.id));
      for (const key of Object.keys(sessions)) {
        if (!ids.has(key)) delete sessions[key];
      }
      for (const [pid, list] of pairs) sessions[pid] = list;
      const selectedProjectId =
        s.selectedProjectId && ids.has(s.selectedProjectId)
          ? s.selectedProjectId
          : (projects[0]?.id ?? null);
      return { projects, sessions, selectedProjectId, ready: true };
    });
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
    const [pid, list] = await loadSessions(id);
    set((s) => ({ sessions: { ...s.sessions, [pid]: list } }));
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

  async createSession(projectId, agent) {
    try {
      const session = await backend.createSession(
        projectId,
        agent,
        get().lastAccessMode,
      );
      const [, list] = await loadSessions(projectId);
      set((s) => ({
        selectedProjectId: projectId,
        preferredAgent: agent,
        sessions: { ...s.sessions, [projectId]: list },
        activeSessionId: { ...s.activeSessionId, [projectId]: session.id },
        openedSessionIds: {
          ...s.openedSessionIds,
          [projectId]: s.openedSessionIds[projectId]?.includes(session.id)
            ? s.openedSessionIds[projectId]
            : [...(s.openedSessionIds[projectId] ?? []), session.id],
        },
        events: { ...s.events, [session.id]: s.events[session.id] ?? [] },
        accessMode: {
          ...s.accessMode,
          [session.id]: s.lastAccessMode,
        },
      }));
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  setSessionAgent(sessionId, agent) {
    set((s) => {
      const sessions: Record<string, Session[]> = {};
      for (const [projectId, list] of Object.entries(s.sessions)) {
        sessions[projectId] = list.map((session) =>
          session.id === sessionId ? { ...session, agent } : session,
        );
      }
      return {
        preferredAgent: agent,
        agentOverride: { ...s.agentOverride, [sessionId]: agent },
        sessions,
      };
    });
    void backend.setSessionAgent(sessionId, agent);
  },

  setAccessMode(sessionId, mode) {
    set((s) => ({
      lastAccessMode: mode,
      accessMode: { ...s.accessMode, [sessionId]: mode },
    }));
    void backend.setAccessMode(sessionId, mode).catch((e) => {
      set({ lastError: String(e) });
    });
  },

  async loadCatalog(sessionId) {
    if (get().catalogs[sessionId]) return;
    try {
      const catalog = await backend.agentCatalog(sessionId);
      set((s) => ({ catalogs: { ...s.catalogs, [sessionId]: catalog } }));
      if (!get().tuning[sessionId] && catalog.models.length > 0) {
        const model =
          catalog.models.find((item) => item.is_default) ?? catalog.models[0];
        const effort =
          model.default_effort || model.efforts[0]?.id || "";
        get().setTuning(sessionId, model.id, effort);
      }
    } catch (e) {
      const message = String(e);
      // 打开还没装上句柄时，catalog 会先撞上这句。只读打开成功后不该留成顶部失败。
      if (message === MISSING_SESSION) return;
      set((s) => ({
        lastError: isReadOnlyOpen(s.events[sessionId]) ? s.lastError : message,
        catalogs: isReadOnlyOpen(s.events[sessionId])
          ? s.catalogs
          : {
              ...s.catalogs,
              [sessionId]: emptyCatalog(),
            },
      }));
    }
  },

  setTuning(sessionId, model, effort) {
    set((s) => ({
      tuning: { ...s.tuning, [sessionId]: { model, effort } },
    }));
    void backend.setSessionTuning(sessionId, model, effort).catch((e) => {
      set({ lastError: String(e) });
    });
  },

  addAttachments(sessionId, files) {
    set((s) => {
      const current = s.attachments[sessionId] ?? [];
      const seen = new Set(current.map((file) => file.path));
      const next = [...current];
      for (const file of files) {
        if (!seen.has(file.path)) {
          seen.add(file.path);
          next.push(file);
        }
      }
      return { attachments: { ...s.attachments, [sessionId]: next } };
    });
  },

  removeAttachment(sessionId, path) {
    set((s) => ({
      attachments: {
        ...s.attachments,
        [sessionId]: (s.attachments[sessionId] ?? []).filter(
          (file) => file.path !== path,
        ),
      },
    }));
  },

  clearAttachments(sessionId) {
    set((s) => ({
      attachments: { ...s.attachments, [sessionId]: [] },
    }));
  },

  async selectSession(projectId, sessionId) {
    set((s) => ({
      selectedProjectId: projectId,
      activeSessionId: { ...s.activeSessionId, [projectId]: sessionId },
      openedSessionIds: {
        ...s.openedSessionIds,
        [projectId]: s.openedSessionIds[projectId]?.includes(sessionId)
          ? s.openedSessionIds[projectId]
          : [...(s.openedSessionIds[projectId] ?? []), sessionId],
      },
    }));
    if (!get().sessions[projectId]) {
      const [pid, list] = await loadSessions(projectId);
      set((s) => ({ sessions: { ...s.sessions, [pid]: list } }));
    }
    try {
      const remote = await backend.getSessionEvents(sessionId);
      set((s) => {
        const merged = mergeEvents(s.events[sessionId], remote);
        return {
          events: {
            ...s.events,
            [sessionId]: merged,
          },
          lastError: clearMissingSessionBanner(s.lastError, merged),
        };
      });
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  seedComposer(sessionId, text) {
    set({ composerSeed: { sessionId, text, token: Date.now() } });
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
