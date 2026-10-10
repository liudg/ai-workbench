import type { StoreApi } from "zustand";

import type {
  AccessMode,
  AgentCatalog,
  AgentInstallation,
  AgentKind,
  AgentProfile,
  Attachment,
  Project,
  PromptAnswer,
  Session,
  SessionEvent,
} from "@/types";
import type { CreateProjectInput, ImportProjectInput } from "@/lib/ipc";
import type { UpdatePhase } from "@/lib/updater";

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

export interface SidebarSlice {
  projects: Project[];
  sessions: Record<string, Session[]>;
  selectedProjectId: string | null;
  activeSessionId: Record<string, string>;
  dialog: DialogMode | null;
  preferredAgent: AgentKind | null;
  agentOverride: Record<string, AgentKind>;
  openDialog(mode: DialogMode): void;
  closeDialog(): void;
  selectProject(id: string): Promise<void>;
  createProject(input: CreateProjectInput): Promise<string | null>;
  importProject(input: ImportProjectInput): Promise<void>;
  removeProject(id: string): Promise<void>;
  createSession(projectId: string, agent: AgentKind): Promise<void>;
  setSessionAgent(sessionId: string, agent: AgentKind): void;
  selectSession(projectId: string, sessionId: string): Promise<void>;
}

export interface WorkspaceSlice {
  events: Record<string, SessionEvent[]>;
  lastAccessMode: AccessMode;
  accessMode: Record<string, AccessMode>;
  attachments: Record<string, Attachment[]>;
  catalogs: Record<string, AgentCatalog>;
  /** 按 Agent 记住的上次成功目录。作曲栏先显示它，再后台刷新。 */
  catalogCache: Partial<Record<AgentKind, AgentCatalog>>;
  /** 目录刷新失败时的一条弱提示。不占用全局红色错误条。 */
  catalogNotice: string | null;
  tuning: Record<string, { model: string; effort: string }>;
  composerSeed: { sessionId: string; text: string; token: number } | null;
  setAccessMode(sessionId: string, mode: AccessMode): void;
  loadCatalog(sessionId: string): Promise<void>;
  setTuning(sessionId: string, model: string, effort: string): void;
  addAttachments(sessionId: string, files: Attachment[]): void;
  removeAttachment(sessionId: string, path: string): void;
  clearAttachments(sessionId: string): void;
  seedComposer(sessionId: string, text: string): void;
  sendMessage(sessionId: string, text: string): Promise<void>;
  answerPrompt(sessionId: string, promptId: string, answer: PromptAnswer): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
}

export interface SettingsSlice {
  installations: AgentInstallation[] | null;
  installationsLoading: boolean;
  installationError: string | null;
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
  UpdatesSlice;

export type WorkbenchSet = StoreApi<WorkbenchState>["setState"];
export type WorkbenchGet = StoreApi<WorkbenchState>["getState"];
