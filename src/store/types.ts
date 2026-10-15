import type { StoreApi } from "zustand";

import type {
  AccessMode,
  SessionSandbox,
  AgentCatalog,
  AgentInstallation,
  AgentKind,
  AgentProfile,
  Attachment,
  PageAnnotation,
  Project,
  PromptAnswer,
  QueuedTurn,
  ReviewStart,
  Session,
  SessionEvent,
  SessionTuning,
} from "@/types";
import type { CreateProjectInput, ImportProjectInput } from "@/lib/ipc";
import type { UpdatePhase } from "@/lib/updater";
import type { PanelSlice } from "@/features/panel/state/slice";

export type DialogMode = "create" | "import";
export type AppScreen = "workspace" | "settings";

export interface ShellSlice {
  ready: boolean;
  lastError: string | null;
  screen: AppScreen;
  init(): Promise<void>;
  refreshAll(): Promise<void>;
  clearError(): void;
  openSettings(): void;
  closeSettings(): void;
}

export type SidebarNotice = { kind: "info"; text: string; token: number };

export interface SidebarSlice {
  projects: Project[];
  sessions: Record<string, Session[]>;
  /** 跑完后还没点开的会话。本地记住，和具体 Agent 无关。 */
  unreadFinishedIds: string[];
  sidebarNotice: SidebarNotice | null;
  lifecycleBusy: string | null;
  /** 工作台本地置顶。和 Agent 能力无关，顺序是最近置顶在前。 */
  pinnedSessionIds: string[];
  selectedProjectId: string | null;
  activeSessionId: Record<string, string>;
  dialog: DialogMode | null;
  preferredAgent: AgentKind | null;
  openDialog(mode: DialogMode): void;
  closeDialog(): void;
  selectProject(id: string): Promise<void>;
  createProject(input: CreateProjectInput): Promise<string | null>;
  importProject(input: ImportProjectInput): Promise<void>;
  removeProject(id: string): Promise<void>;
  /** 返回新会话 id；失败时写 lastError 并返回 null。 */
  createSession(projectId: string, agent: AgentKind): Promise<string | null>;
  selectSession(projectId: string, sessionId: string): Promise<void>;
  releaseMissingSession(sessionId: string): void;
  renameSession(sessionId: string, name: string): Promise<boolean>;
  forkSession(projectId: string, sessionId: string): Promise<void>;
  togglePinnedSession(sessionId: string): void;
  archiveSession(projectId: string, sessionId: string, archived: boolean): Promise<boolean>;
  deleteSession(projectId: string, sessionId: string): Promise<boolean>;
}

export interface WorkspaceSlice {
  events: Record<string, SessionEvent[]>;
  accessMode: Record<string, AccessMode>;
  /** 只记住同一个 Agent 上一次的沙箱，不拿去填另一个 Agent。 */
  lastSandboxByAgent: Partial<Record<AgentKind, SessionSandbox>>;
  sandboxes: Record<string, SessionSandbox>;
  attachments: Record<string, Attachment[]>;
  pageAnnotations: Record<string, PageAnnotation[]>;
  queues: Record<string, QueuedTurn[]>;
  catalogs: Record<string, AgentCatalog>;
  /** 目录刷新失败时的一条弱提示，按会话分开。 */
  catalogNotices: Record<string, string>;
  tuning: Record<string, SessionTuning>;
  setSandbox(sessionId: string, sandbox: SessionSandbox): void;
  loadCatalog(sessionId: string): Promise<void>;
  setTuning(sessionId: string, model: string, effort: string, serviceTier?: string | null): void;
  addAttachments(sessionId: string, files: Attachment[]): void;
  removeAttachment(sessionId: string, path: string): void;
  clearAttachments(sessionId: string): void;
  replaceAttachments(sessionId: string, files: Attachment[]): void;
  addPageAnnotation(sessionId: string, note: PageAnnotation): void;
  removePageAnnotation(sessionId: string, id: string): void;
  clearPageAnnotations(sessionId: string): void;
  sendMessage(
    sessionId: string,
    text: string,
    images?: string[],
    annotations?: PageAnnotation[],
  ): Promise<void>;
  setCollaborationMode(sessionId: string, mode: "plan" | "default"): Promise<void>;
  startReview(sessionId: string, target: ReviewStart): Promise<void>;
  answerPrompt(sessionId: string, promptId: string, answer: PromptAnswer): Promise<void>;
  loadOlderHistory(sessionId: string): Promise<boolean>;
  stopSession(sessionId: string): Promise<void>;
}

export interface SettingsSlice {
  installations: AgentInstallation[] | null;
  installationsLoading: boolean;
  installationError: string | null;
  /** 某张 Agent 卡片上的更新失败。和分区顶部的 `installationError` 分开。 */
  updateErrors: Partial<Record<AgentKind, string>>;
  updatingKind: AgentKind | null;
  profiles: Partial<Record<AgentKind, AgentProfile>>;
  refreshInstallations(): Promise<void>;
  updateInstallation(kind: AgentKind): Promise<void>;
}

export interface UpdatesSlice {
  update: UpdatePhase;
  updateDialogOpen: boolean;
  checkUpdates(manual: boolean): Promise<void>;
  startInstall(): Promise<void>;
  closeUpdateDialog(): void;
}

export type WorkbenchState = ShellSlice &
  SidebarSlice &
  WorkspaceSlice &
  SettingsSlice &
  UpdatesSlice &
  PanelSlice;

export type WorkbenchSet = StoreApi<WorkbenchState>["setState"];
export type WorkbenchGet = StoreApi<WorkbenchState>["getState"];
