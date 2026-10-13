// 后端接口。UI 层只依赖本文件导出的 `backend`；命令走 `transport`
// （桌面版是 Tauri IPC，网页预览是连着同一套 Rust 后端的 dev bridge）。

import type {
  AgentInstallation,
  AgentKind,
  AccessMode,
  PermissionMenu,
  SessionSandbox,
  AgentCatalogRefresh,
  AgentProfile,
  CachedAgentCatalog,
  Attachment,
  PageAnnotation,
  Project,
  PromptAnswer,
  QueuedTurn,
  ReviewStart,
  ReviewTargets,
  OlderHistory,
  Session,
  SessionEvent,
} from "@/types";
import { isTauri, transport } from "./transport";

export { isTauri };

const invoke = <T = void>(cmd: string, args?: Record<string, unknown>) =>
  transport.call<T>(cmd, args);

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

export interface TreeEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | string;
}

export interface PathFilter {
  paths: string[];
  truncated: boolean;
  cancelled: boolean;
}

export interface FileSearchHit {
  path: string;
  line: number | null;
  text: string;
  kind: "content" | "name" | string;
}

export interface FileSearchResult {
  hits: FileSearchHit[];
  truncated: boolean;
  done: boolean;
  cancelled: boolean;
}

export interface PreviewDocument {
  path: string;
  name: string;
  kind: string;
  text: string;
  truncated: boolean;
}

export interface BrowserFile {
  display: string;
  url: string;
}

export interface DiffScope {
  id: string;
  label: string;
  /** `git` 或 `turn`。 */
  source: string;
}

export interface SessionRequest {
  session_id: string;
  project_id: string;
  agent: AgentKind;
  name: string | null;
  text: string | null;
}

export interface BrowserNotice {
  kind: string;
  value: string;
}

export interface Backend {
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<CreateProjectResult>;
  importProject(input: ImportProjectInput): Promise<Project>;
  removeProject(id: string): Promise<void>;

  listSessions(projectId: string): Promise<Session[]>;
  forkSession(sessionId: string): Promise<Session>;
  renameSession(sessionId: string, name: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  createSession(
    projectId: string,
    agent?: AgentKind,
    accessMode?: AccessMode,
  ): Promise<Session>;
  /** 切换会话后续使用的 Agent。 */
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
  sendMessage(
    sessionId: string,
    text: string,
    images?: string[],
    annotations?: PageAnnotation[],
  ): Promise<void>;
  /** 把一条页面批注交给当前会话的 AnnotationSink。 */
  submitAnnotation(sessionId: string, note: PageAnnotation): Promise<void>;
  /** DiffScopeProvider：当前适配器提供的差异范围。 */
  diffScopes(sessionId: string): Promise<DiffScope[]>;
  diffForScope(
    sessionId: string,
    scope: string,
    ignoreWhitespace: boolean,
  ): Promise<string>;
  /**
   * 项目目录是不是 git 工作区。
   * 后端用 Codex 同一条探测：`git rev-parse --is-inside-work-tree`。
   */
  projectIsGit(projectId: string): Promise<boolean>;
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
  /** `thread/goal/set`。 */
  setThreadGoal(sessionId: string, objective: string): Promise<void>;
  /** `thread/goal/clear`。 */
  clearThreadGoal(sessionId: string): Promise<void>;
  /** `thread/goal/get`。没有线程时成功且不产生目标事件。 */
  publishThreadGoal(sessionId: string): Promise<void>;
  reviewTargets(sessionId: string): Promise<ReviewTargets>;
  startReview(sessionId: string, target: ReviewStart): Promise<void>;
  answerPrompt(
    sessionId: string,
    promptId: string,
    answer: PromptAnswer,
  ): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  getSessionEvents(sessionId: string): Promise<SessionEvent[]>;
  loadOlderHistory(sessionId: string): Promise<OlderHistory>;
  /** 读取项目目录内的文本，供 HTML / Markdown / 纯文本预览。 */
  readPreviewFile(projectId: string, path: string): Promise<PreviewDocument>;
  /** 工作区某一层目录。展开后再读下一层，不把整棵树截断。 */
  listProjectDir(projectId: string, path: string): Promise<TreeEntry[]>;
  /** 按相对路径筛选工作区文件。未接入的查询会带 cancelled。 */
  filterProjectPaths(projectId: string, query: string): Promise<PathFilter>;
  /** 在项目目录里搜索文件名和文本。分段返回，searchId 用来取消上一段。 */
  searchProjectFiles(
    projectId: string,
    query: string,
    mask: string,
    searchId: number,
  ): Promise<FileSearchResult>;
  /** 用系统默认程序打开项目内的文件。 */
  openProjectFile(projectId: string, path: string): Promise<void>;
  /** 把项目内文件放进内置浏览器可加载的地址。 */
  prepareBrowserFile(projectId: string, path: string): Promise<BrowserFile>;
  browserShow(url: string, x: number, y: number, width: number, height: number): Promise<void>;
  browserBounds(x: number, y: number, width: number, height: number): Promise<void>;
  browserHide(): Promise<void>;
  browserReload(): Promise<void>;
  browserAnnotate(on: boolean): Promise<void>;
  browserOpenExternal(target: string): Promise<void>;
  browserClose(): Promise<void>;
  onBrowserNotice(cb: (notice: BrowserNotice) => void): () => void;

  /** 打开系统目录选择器；返回 null 表示取消 */
  pickDirectory(title: string): Promise<string | null>;
  /** 选择要附加的文件；取消时返回空数组 */
  pickFiles(): Promise<Attachment[]>;
  /** `@` 菜单「文件和文件夹」。选中的路径由作曲栏写成文件提及。 */
  pickMentionFiles(): Promise<Attachment[]>;
  pickImageFiles(): Promise<Attachment[]>;

  onSessionEvent(cb: (event: SessionEvent) => void): () => void;
  onSessionQueue(
    cb: (payload: { session_id: string; items: QueuedTurn[] }) => void,
  ): () => void;
  onSessionsChanged(cb: (projectId: string) => void): () => void;
  /** 适配器请求在同一项目新开会话（/new、/clear、计划「清空上下文后实施」）。 */
  onSessionRequest(cb: (request: SessionRequest) => void): () => void;
  onProjectsChanged(cb: () => void): () => void;
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  return transport.listen<T>(channel, cb);
}

function attachments(paths: string[]): Attachment[] {
  return paths.map((path) => ({
    name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    path,
  }));
}

export const backend: Backend = {
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

  listSessions: (projectId) => invoke<Session[]>("list_sessions", { projectId }),
  forkSession: (sessionId) => invoke<Session>("fork_session", { sessionId }),
  renameSession: (sessionId, name) =>
    invoke("rename_session", { sessionId, name }),
  deleteSession: (sessionId) => invoke("delete_session", { sessionId }),
  createSession: (projectId, agent, accessMode) =>
    invoke<Session>("create_session", {
      projectId,
      agent: agent ?? null,
      accessMode: accessMode ?? null,
    }),
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
  sendMessage: (sessionId, text, images, annotations) =>
    invoke("send_message", {
      sessionId,
      text,
      images: images ?? [],
      annotations: annotations ?? [],
    }),
  submitAnnotation: (sessionId, note) =>
    invoke("submit_annotation", { sessionId, note }),
  diffScopes: (sessionId) => invoke<DiffScope[]>("diff_scopes", { sessionId }),
  diffForScope: (sessionId, scope, ignoreWhitespace) =>
    invoke<string>("diff_for_scope", { sessionId, scope, ignoreWhitespace }),
  projectIsGit: (projectId) => invoke<boolean>("project_is_git", { projectId }),
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
  setThreadGoal: (sessionId, objective) =>
    invoke("set_thread_goal", { sessionId, objective }),
  clearThreadGoal: (sessionId) => invoke("clear_thread_goal", { sessionId }),
  publishThreadGoal: (sessionId) => invoke("publish_thread_goal", { sessionId }),
  reviewTargets: (sessionId) =>
    invoke<ReviewTargets>("review_targets", { sessionId }),
  startReview: (sessionId, target) =>
    invoke("start_review", { sessionId, target }),
  answerPrompt: (sessionId, promptId, answer) =>
    invoke("answer_prompt", { sessionId, promptId, answer }),
  stopSession: (sessionId) => invoke("stop_session", { sessionId }),
  getSessionEvents: (sessionId) =>
    invoke<SessionEvent[]>("get_session_events", { sessionId }),
  loadOlderHistory: (sessionId) =>
    invoke<OlderHistory>("load_older_history", { sessionId }),
  readPreviewFile: (projectId, path) =>
    invoke<PreviewDocument>("read_preview_file", { projectId, path }),
  listProjectDir: (projectId, path) =>
    invoke<TreeEntry[]>("list_project_dir", { projectId, path }),
  filterProjectPaths: (projectId, query) =>
    invoke<PathFilter>("filter_project_paths", { projectId, query }),
  searchProjectFiles: (projectId, query, mask, searchId) =>
    invoke<FileSearchResult>("search_project_files", { projectId, query, mask, searchId }),
  openProjectFile: (projectId, path) =>
    invoke("open_project_file", { projectId, path }),
  prepareBrowserFile: (projectId, path) =>
    invoke<BrowserFile>("prepare_browser_file", { projectId, path }),
  browserShow: (url, x, y, width, height) =>
    invoke("browser_show", { url, x, y, width, height }),
  browserBounds: (x, y, width, height) =>
    invoke("browser_bounds", { x, y, width, height }),
  browserHide: () => invoke("browser_hide"),
  browserReload: () => invoke("browser_reload"),
  browserAnnotate: (on) => invoke("browser_annotate", { on }),
  browserOpenExternal: (target) => invoke("browser_open_external", { target }),
  browserClose: () => invoke("browser_close"),
  onBrowserNotice: (cb) => subscribe<BrowserNotice>("preview-browser", cb),

  pickDirectory: async (title) => {
    const [selected] = await transport.pick({ directory: true, multiple: false, title });
    return selected ?? null;
  },
  pickImageFiles: async () =>
    attachments(
      await transport.pick({
        directory: false,
        multiple: true,
        title: "添加照片和文件",
        filters: [
          {
            name: "图片",
            extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"],
          },
        ],
      }),
    ),
  pickFiles: async () =>
    attachments(await transport.pick({ directory: false, multiple: true, title: "添加附件" })),
  pickMentionFiles: async () =>
    attachments(
      await transport.pick({ directory: false, multiple: true, title: "文件和文件夹" }),
    ),

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
  onSessionRequest: (cb) => subscribe<SessionRequest>("session-request", cb),
};

