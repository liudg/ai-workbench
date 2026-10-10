// 后端接口抽象：Tauri 环境走 invoke/listen，浏览器预览走内存 mock。
// UI 层只依赖本文件导出的 `backend`，不关心运行环境。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  AgentInstallation,
  AgentKind,
  AccessMode,
  PermissionMenu,
  SessionSandbox,
  AgentCatalogRefresh,
  AgentProfile,
  CachedAgentCatalog,
  EnvironmentRecord,
  HookRecord,
  McpLogin,
  McpServerRecord,
  McpTransport,
  PluginCatalog,
  ReloadReport,
  WorktreeInfo,
  WorktreeSettings,
  Attachment,
  Project,
  PromptAnswer,
  QueuedTurn,
  ReviewStart,
  ReviewTargets,
  Session,
  SessionEvent,
} from "@/types";
import { mockBackend } from "./mock";

export interface CreateProjectInput {
  name: string;
  parentDir: string;
  defaultAgent: AgentKind;
  initGit: boolean;
}

export interface CreateProjectResult {
  project: Project;
  warning: string | null;
}

export interface ImportProjectInput {
  path: string;
  name?: string;
  defaultAgent: AgentKind;
}

export interface Backend {
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<CreateProjectResult>;
  importProject(input: ImportProjectInput): Promise<Project>;
  removeProject(id: string): Promise<void>;

  listSessions(projectId: string, archived?: boolean): Promise<Session[]>;
  forkSession(sessionId: string): Promise<Session>;
  renameSession(sessionId: string, name: string): Promise<void>;
  setSessionArchived(sessionId: string, archived: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  createSession(
    projectId: string,
    agent?: AgentKind,
    accessMode?: AccessMode,
  ): Promise<Session>;
  /** 切换会话后续使用的 Agent。 */
  setSessionAgent(sessionId: string, agent: AgentKind): Promise<void>;
  /** 更新权限档位、网络、额外可写目录和配置档。各适配器自行映射。 */
  setSandbox(sessionId: string, sandbox: SessionSandbox): Promise<void>;
  /** 当前 app-server 是否提供网络档、配置档和替我批准。 */
  permissionMenu(sessionId: string): Promise<PermissionMenu>;
  /** 各 Agent 的能力与斜杠命令。不需要已打开的会话。 */
  agentProfiles(): Promise<AgentProfile[]>;
  /** 本机 CLI 安装与官方更新状态。 */
  listAgentInstallations(): Promise<AgentInstallation[]>;
  /** 按该 Agent 的官方渠道升级，并返回刷新后的状态。 */
  updateAgent(kind: AgentKind): Promise<AgentInstallation>;
  /** 启动时读取各 Agent 上次成功的模型目录。 */
  cachedAgentCatalogs(): Promise<CachedAgentCatalog[]>;
  /** 当前会话 Agent 报告的模型、推理强度和技能。失败时可能带回缓存和一条提示。 */
  agentCatalog(sessionId: string): Promise<AgentCatalogRefresh>;
  setSessionTuning(
    sessionId: string,
    model: string,
    effort: string,
  ): Promise<void>;
  sendMessage(sessionId: string, text: string, images?: string[]): Promise<void>;
  updateQueuedTurn(
    sessionId: string,
    queuedId: string,
    text: string,
    images?: string[],
  ): Promise<void>;
  removeQueuedTurn(sessionId: string, queuedId: string): Promise<void>;
  sessionQueue(sessionId: string): Promise<QueuedTurn[]>;
  interruptTurn(sessionId: string): Promise<void>;
  stageChatImage(dataBase64: string, name: string): Promise<Attachment>;
  setCollaborationMode(sessionId: string, mode: "plan" | "default"): Promise<void>;
  reviewTargets(sessionId: string): Promise<ReviewTargets>;
  startReview(sessionId: string, target: ReviewStart): Promise<void>;
  revertTurn(sessionId: string, turnId: string): Promise<void>;
  answerPrompt(
    sessionId: string,
    promptId: string,
    answer: PromptAnswer,
  ): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  getSessionEvents(sessionId: string): Promise<SessionEvent[]>;

  listMcpServers(): Promise<McpServerRecord[]>;
  addMcpServer(input: {
    name: string;
    transport: McpTransport;
    commandLine: string;
    url: string;
  }): Promise<void>;
  setMcpServerEnabled(name: string, enabled: boolean): Promise<void>;
  removeMcpServer(name: string): Promise<void>;
  loginMcpServer(name: string): Promise<McpLogin>;
  reloadMcpServers(): Promise<ReloadReport>;

  listPlugins(cwd: string | null): Promise<PluginCatalog>;
  installPlugin(input: {
    pluginName: string;
    marketplacePath: string;
    marketplaceName: string;
  }): Promise<void>;
  uninstallPlugin(pluginId: string): Promise<void>;
  addMarketplace(source: string, refName: string): Promise<void>;
  removeMarketplace(name: string): Promise<void>;
  upgradeMarketplace(name: string): Promise<void>;

  listHooks(cwd: string | null): Promise<HookRecord[]>;

  worktreeSettings(projectPath: string | null): Promise<WorktreeSettings>;
  saveWorktreeSettings(
    root: string,
    keep: number,
    autoPrune: boolean,
  ): Promise<WorktreeSettings>;
  createWorktree(projectPath: string): Promise<WorktreeInfo>;
  recycleWorktree(projectPath: string, worktreePath: string): Promise<void>;

  addEnvironment(input: {
    environmentId: string;
    execServerUrl: string;
    authBearerToken: string;
  }): Promise<EnvironmentRecord>;
  listEnvironments(): Promise<EnvironmentRecord[]>;

  /** 打开系统目录选择器；返回 null 表示取消 */
  pickDirectory(title: string): Promise<string | null>;
  /** 选择要附加的文件；取消时返回空数组 */
  pickFiles(): Promise<Attachment[]>;
  pickImageFiles(): Promise<Attachment[]>;

  onSessionEvent(cb: (event: SessionEvent) => void): () => void;
  onSessionQueue(
    cb: (payload: { session_id: string; items: QueuedTurn[] }) => void,
  ): () => void;
  onSessionsChanged(cb: (projectId: string) => void): () => void;
  onProjectsChanged(cb: () => void): () => void;
}

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function subscribe<T>(
  channel: string,
  cb: (payload: T) => void,
): () => void {
  let unlisten: (() => void) | undefined;
  listen<T>(channel, (e) => cb(e.payload)).then((u) => {
    unlisten = u;
  });
  return () => unlisten?.();
}

const tauriBackend: Backend = {
  listProjects: () => invoke<Project[]>("list_projects"),
  createProject: (input) =>
    invoke<CreateProjectResult>("create_project", {
      name: input.name,
      parentDir: input.parentDir,
      defaultAgent: input.defaultAgent,
      initGit: input.initGit,
    }),
  importProject: (input) =>
    invoke<Project>("import_project", {
      path: input.path,
      name: input.name ?? null,
      defaultAgent: input.defaultAgent,
    }),
  removeProject: (id) => invoke("remove_project", { id }),

  listSessions: (projectId, archived) =>
    invoke<Session[]>("list_sessions", { projectId, archived: archived ?? false }),
  forkSession: (sessionId) => invoke<Session>("fork_session", { sessionId }),
  renameSession: (sessionId, name) =>
    invoke("rename_session", { sessionId, name }),
  setSessionArchived: (sessionId, archived) =>
    invoke("set_session_archived", { sessionId, archived }),
  deleteSession: (sessionId) => invoke("delete_session", { sessionId }),
  createSession: (projectId, agent, accessMode) =>
    invoke<Session>("create_session", {
      projectId,
      agent: agent ?? null,
      accessMode: accessMode ?? null,
    }),
  setSessionAgent: (sessionId, agent) =>
    invoke("set_session_agent", { sessionId, agent }),
  setSandbox: (sessionId, sandbox) =>
    invoke("set_session_access", {
      sessionId,
      mode: sandbox.profileId ? "ask" : sandbox.mode,
      networkAccess: sandbox.networkAccess,
      writableRoots: sandbox.writableRoots,
      profileId: sandbox.profileId,
    }),
  permissionMenu: (sessionId) =>
    invoke<PermissionMenu>("session_permission_menu", { sessionId }),
  agentProfiles: () => invoke<AgentProfile[]>("agent_profiles"),
  listAgentInstallations: () =>
    invoke<AgentInstallation[]>("list_agent_installations"),
  updateAgent: (kind) => invoke<AgentInstallation>("update_agent", { kind }),
  cachedAgentCatalogs: () =>
    invoke<CachedAgentCatalog[]>("cached_agent_catalogs"),
  agentCatalog: (sessionId) =>
    invoke<AgentCatalogRefresh>("agent_catalog", { sessionId }),
  setSessionTuning: (sessionId, model, effort) =>
    invoke("set_session_tuning", { sessionId, model, effort }),
  sendMessage: (sessionId, text, images) =>
    invoke("send_message", { sessionId, text, images: images ?? [] }),
  updateQueuedTurn: (sessionId, queuedId, text, images) =>
    invoke("update_queued_turn", {
      sessionId,
      queuedId,
      text,
      images: images ?? [],
    }),
  removeQueuedTurn: (sessionId, queuedId) =>
    invoke("remove_queued_turn", { sessionId, queuedId }),
  sessionQueue: (sessionId) =>
    invoke("session_queue", { sessionId }),
  interruptTurn: (sessionId) => invoke("interrupt_turn", { sessionId }),
  stageChatImage: (dataBase64, name) =>
    invoke("stage_chat_image", { dataBase64, name }),
  setCollaborationMode: (sessionId, mode) =>
    invoke("set_collaboration_mode", { sessionId, mode }),
  reviewTargets: (sessionId) =>
    invoke<ReviewTargets>("review_targets", { sessionId }),
  startReview: (sessionId, target) =>
    invoke("start_review", { sessionId, target }),
  revertTurn: (sessionId, turnId) =>
    invoke("revert_turn", { sessionId, turnId }),
  answerPrompt: (sessionId, promptId, answer) =>
    invoke("answer_prompt", { sessionId, promptId, answer }),
  stopSession: (sessionId) => invoke("stop_session", { sessionId }),
  getSessionEvents: (sessionId) =>
    invoke<SessionEvent[]>("get_session_events", { sessionId }),

  listMcpServers: () => invoke<McpServerRecord[]>("list_mcp_servers"),
  addMcpServer: (input) =>
    invoke("add_mcp_server", {
      name: input.name,
      transport: input.transport,
      commandLine: input.commandLine,
      url: input.url,
    }),
  setMcpServerEnabled: (name, enabled) =>
    invoke("set_mcp_server_enabled", { name, enabled }),
  removeMcpServer: (name) => invoke("remove_mcp_server", { name }),
  loginMcpServer: (name) => invoke<McpLogin>("login_mcp_server", { name }),
  reloadMcpServers: () => invoke<ReloadReport>("reload_mcp_servers"),
  listPlugins: (cwd) => invoke<PluginCatalog>("list_plugins", { cwd }),
  installPlugin: (input) =>
    invoke("install_plugin", {
      pluginName: input.pluginName,
      marketplacePath: input.marketplacePath,
      marketplaceName: input.marketplaceName,
    }),
  uninstallPlugin: (pluginId) => invoke("uninstall_plugin", { pluginId }),
  addMarketplace: (source, refName) =>
    invoke("add_marketplace", { source, refName }),
  removeMarketplace: (name) => invoke("remove_marketplace", { name }),
  upgradeMarketplace: (name) => invoke("upgrade_marketplace", { name }),
  listHooks: (cwd) => invoke<HookRecord[]>("list_hooks", { cwd }),
  worktreeSettings: (projectPath) =>
    invoke<WorktreeSettings>("worktree_settings", { projectPath }),
  saveWorktreeSettings: (root, keep, autoPrune) =>
    invoke<WorktreeSettings>("save_worktree_settings", { root, keep, autoPrune }),
  createWorktree: (projectPath) =>
    invoke<WorktreeInfo>("create_worktree", { projectPath }),
  recycleWorktree: (projectPath, worktreePath) =>
    invoke("recycle_worktree", { projectPath, worktreePath }),
  addEnvironment: (input) =>
    invoke<EnvironmentRecord>("add_environment", {
      environmentId: input.environmentId,
      execServerUrl: input.execServerUrl,
      authBearerToken: input.authBearerToken,
    }),
  listEnvironments: () => invoke<EnvironmentRecord[]>("list_environments"),

  pickDirectory: async (title) => {
    const selected = await open({ directory: true, multiple: false, title });
    return typeof selected === "string" ? selected : null;
  },
  pickImageFiles: async () => {
    const selected = await open({
      directory: false,
      multiple: true,
      title: "添加照片和文件",
      filters: [
        {
          name: "图片",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"],
        },
      ],
    });
    if (!selected) return [];
    const paths = Array.isArray(selected) ? selected : [selected];
    return paths.map((path) => ({
      name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
      path,
    }));
  },
  pickFiles: async () => {
    const selected = await open({
      directory: false,
      multiple: true,
      title: "添加附件",
    });
    if (!selected) return [];
    const paths = Array.isArray(selected) ? selected : [selected];
    return paths.map((path) => ({
      name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
      path,
    }));
  },

  onSessionEvent: (cb) => subscribe<SessionEvent>("session-event", cb),
  onSessionQueue: (cb) =>
    subscribe<{ session_id: string; items: QueuedTurn[] }>(
      "session-queue",
      cb,
    ),
  onSessionsChanged: (cb) =>
    subscribe<{ project_id: string }>("sessions-changed", (p) =>
      cb(p.project_id),
    ),
  onProjectsChanged: (cb) => subscribe("projects-changed", () => cb()),
};

export const backend: Backend = isTauri ? tauriBackend : mockBackend;
