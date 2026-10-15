import type {
  AgentInstallation,
  AgentKind,
  AccessMode,
  PermissionMenu,
  SessionSandbox,
  AgentCatalogRefresh,
  AgentProfile,
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
import type {
  BrowserFile,
  BrowserNotice,
  CreateProjectInput,
  CreateProjectResult,
  DiffScope,
  FileSearchResult,
  ImportProjectInput,
  PathFilter,
  PreviewDocument,
  PreviewImage,
  SessionRequest,
  TreeEntry,
} from "./dto";

export interface Backend {
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<CreateProjectResult>;
  importProject(input: ImportProjectInput): Promise<Project>;
  removeProject(id: string): Promise<void>;

  listSessions(projectId: string): Promise<Session[]>;
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
  /** 当前会话 Agent 报告的模型、推理强度和技能。失败时可能带回缓存和一条提示。 */
  agentCatalog(sessionId: string): Promise<AgentCatalogRefresh>;
  setSessionTuning(
    sessionId: string,
    model: string,
    effort: string,
  ): Promise<void>;
  /** `null` 关掉速度档。只有目录里有对应 service tier 时作曲栏才会调用。 */
  setSessionServiceTier(sessionId: string, serviceTier: string | null): Promise<void>;
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
  /**
   * 当前 git 分支。不是仓库、分离头指针或空输出时为 null。
   * 探测失败（git 不存在、目录不存在）时拒绝，而不是返回一个假分支名。
   */
  projectBranch(projectId: string): Promise<string | null>;
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
  /** 暂停或继续当前目标。`paused` / `active`，不改目标正文。 */
  setThreadGoalStatus(sessionId: string, status: "paused" | "active"): Promise<void>;
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
  /** 读取 png / jpg / gif / webp / svg / bmp 等图片的真实字节。 */
  readPreviewImage(projectId: string, path: string): Promise<PreviewImage>;
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
