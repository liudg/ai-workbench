// 后端接口抽象：Tauri 环境走 invoke/listen，浏览器预览走内存 mock。
// UI 层只依赖本文件导出的 `backend`，不关心运行环境。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  AgentKind,
  AccessMode,
  AgentCatalog,
  Attachment,
  Project,
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

  listSessions(projectId: string): Promise<Session[]>;
  createSession(
    projectId: string,
    agent?: AgentKind,
    accessMode?: AccessMode,
  ): Promise<Session>;
  /** 切换会话后续使用的 Agent。 */
  setSessionAgent(sessionId: string, agent: AgentKind): Promise<void>;
  /** 更新 Codex 沙箱 / 审批。Claude 桩会话会忽略。 */
  setAccessMode(sessionId: string, mode: AccessMode): Promise<void>;
  /** 当前会话 Agent 报告的模型、推理强度和技能。 */
  agentCatalog(sessionId: string): Promise<AgentCatalog>;
  setSessionTuning(
    sessionId: string,
    model: string,
    effort: string,
  ): Promise<void>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  answerPrompt(
    sessionId: string,
    promptId: string,
    answer: string,
  ): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  getSessionEvents(sessionId: string): Promise<SessionEvent[]>;

  /** 打开系统目录选择器；返回 null 表示取消 */
  pickDirectory(title: string): Promise<string | null>;
  /** 选择要附加的文件；取消时返回空数组 */
  pickFiles(): Promise<Attachment[]>;

  onSessionEvent(cb: (event: SessionEvent) => void): () => void;
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

  listSessions: (projectId) =>
    invoke<Session[]>("list_sessions", { projectId }),
  createSession: (projectId, agent, accessMode) =>
    invoke<Session>("create_session", {
      projectId,
      agent: agent ?? null,
      accessMode: accessMode ?? null,
    }),
  setSessionAgent: (sessionId, agent) =>
    invoke("set_session_agent", { sessionId, agent }),
  setAccessMode: (sessionId, mode) =>
    invoke("set_session_access", { sessionId, mode }),
  agentCatalog: (sessionId) =>
    invoke<AgentCatalog>("agent_catalog", { sessionId }),
  setSessionTuning: (sessionId, model, effort) =>
    invoke("set_session_tuning", { sessionId, model, effort }),
  sendMessage: (sessionId, text) =>
    invoke("send_message", { sessionId, text }),
  answerPrompt: (sessionId, promptId, answer) =>
    invoke("answer_prompt", { sessionId, promptId, answer }),
  stopSession: (sessionId) => invoke("stop_session", { sessionId }),
  getSessionEvents: (sessionId) =>
    invoke<SessionEvent[]>("get_session_events", { sessionId }),

  pickDirectory: async (title) => {
    const selected = await open({ directory: true, multiple: false, title });
    return typeof selected === "string" ? selected : null;
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
  onSessionsChanged: (cb) =>
    subscribe<{ project_id: string }>("sessions-changed", (p) =>
      cb(p.project_id),
    ),
  onProjectsChanged: (cb) => subscribe("projects-changed", () => cb()),
};

export const backend: Backend = isTauri ? tauriBackend : mockBackend;
