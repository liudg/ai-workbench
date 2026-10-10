// 浏览器预览用的内存 mock 后端。
// 行为镜像 src-tauri 的适配器桩（stub.rs）：首轮消息演示工具调用 + 审批提问，
// 之后轮次直接完成。让 UI 在没有 Rust 后端的浏览器里也能完整演示。

import type {
  AgentKind,
  Project,
  PromptOption,
  Session,
  SessionEvent,
  SessionEventBody,
  SessionStatus,
} from "@/types";
import type {
  Backend,
  CreateProjectInput,
  CreateProjectResult,
  ImportProjectInput,
} from "./ipc";

let seq = 0;
const id = () => `mock-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const now = () => Date.now();

interface MockSessionState {
  meta: Session;
  events: SessionEvent[];
  turns: number;
  pendingPrompt: string | null;
  timers: ReturnType<typeof setTimeout>[];
}

const projects: Project[] = [];
const sessions = new Map<string, MockSessionState>();

type Listener<T> = (payload: T) => void;
const eventListeners = new Set<Listener<SessionEvent>>();
const sessionsChangedListeners = new Set<Listener<string>>();
const projectsChangedListeners = new Set<Listener<void>>();

function pushEvent(sessionId: string, body: SessionEventBody) {
  const s = sessions.get(sessionId);
  if (!s) return;
  const event = {
    id: id(),
    session_id: sessionId,
    seq: s.events.length + 1,
    ts: now(),
    ...body,
  } as SessionEvent;
  s.events.push(event);
  if (body.kind === "status-changed") {
    s.meta.status = body.status;
    s.meta.updated_at = now();
  }
  eventListeners.forEach((cb) => cb(event));
  if (body.kind === "status-changed") {
    sessionsChangedListeners.forEach((cb) => cb(s.meta.project_id));
  }
}

function setStatus(sessionId: string, status: SessionStatus) {
  pushEvent(sessionId, { kind: "status-changed", status });
}

function schedule(s: MockSessionState, fn: () => void, ms: number) {
  s.timers.push(setTimeout(fn, ms));
}

function agentLabel(agent: AgentKind) {
  return agent === "codex-cli" ? "Codex CLI" : "Claude Code";
}

const APPROVAL_OPTIONS: PromptOption[] = [
  { id: "approve", label: "允许" },
  { id: "reject", label: "拒绝" },
];

export const mockBackend: Backend = {
  async listProjects() {
    return [...projects];
  },

  async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    const project: Project = {
      id: id(),
      name: input.name.trim(),
      path: `${input.parentDir.replace(/[\\/]+$/, "")}/${input.name.trim()}`,
      default_agent: input.defaultAgent,
      created_at: now(),
      updated_at: now(),
    };
    projects.push(project);
    projectsChangedListeners.forEach((cb) => cb());
    return { project, warning: null };
  },

  async importProject(input: ImportProjectInput) {
    const name =
      input.name?.trim() ||
      input.path.split(/[\\/]/).filter(Boolean).pop() ||
      "未命名项目";
    const project: Project = {
      id: id(),
      name,
      path: input.path,
      default_agent: input.defaultAgent,
      created_at: now(),
      updated_at: now(),
    };
    projects.push(project);
    projectsChangedListeners.forEach((cb) => cb());
    return project;
  },

  async removeProject(projectId) {
    const idx = projects.findIndex((p) => p.id === projectId);
    if (idx >= 0) projects.splice(idx, 1);
    for (const [sid, s] of sessions) {
      if (s.meta.project_id === projectId) {
        s.timers.forEach(clearTimeout);
        sessions.delete(sid);
      }
    }
    projectsChangedListeners.forEach((cb) => cb());
  },

  async listSessions(projectId) {
    return [...sessions.values()]
      .filter((s) => s.meta.project_id === projectId)
      .map((s) => ({ ...s.meta }))
      .sort((a, b) => a.created_at - b.created_at);
  },

  async createSession(projectId, agent) {
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new Error("项目不存在");
    const kind = agent ?? project.default_agent;
    const sessionId = id();
    const count = [...sessions.values()].filter(
      (s) => s.meta.project_id === projectId,
    ).length;
    const meta: Session = {
      id: sessionId,
      project_id: projectId,
      agent: kind,
      title: `会话 ${count + 1}`,
      status: "running",
      created_at: now(),
      updated_at: now(),
    };
    const state: MockSessionState = {
      meta,
      events: [],
      turns: 0,
      pendingPrompt: null,
      timers: [],
    };
    sessions.set(sessionId, state);
    pushEvent(sessionId, {
      kind: "system",
      text: `${agentLabel(kind)} 会话已就绪（浏览器预览 mock · 目录 ${project.path}）`,
    });
    setStatus(sessionId, "completed");
    return { ...meta, status: "completed" };
  },

  async setSessionAgent(sessionId, agent) {
    const s = sessions.get(sessionId);
    if (!s || !agent) return;
    s.meta.agent = agent;
    s.meta.updated_at = now();
    sessionsChangedListeners.forEach((cb) => cb(s.meta.project_id));
  },

  async sendMessage(sessionId, text) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("会话不存在");
    if (s.pendingPrompt) throw new Error("存在待回答的提问，请先处理");
    pushEvent(sessionId, {
      kind: "user-message",
      text,
    });
    if (s.meta.title.startsWith("会话 ")) {
      s.meta.title = text.split("\n")[0].slice(0, 24);
      sessionsChangedListeners.forEach((cb) => cb(s.meta.project_id));
    }
    s.turns += 1;
    const turn = s.turns;
    setStatus(sessionId, "running");

    schedule(
      s,
      () =>
        pushEvent(sessionId, {
          kind: "agent-message",
          text: `已收到任务（${agentLabel(s.meta.agent)} 桩模式）：「${text.slice(
            0,
            48,
          )}」。\n\n正在分析项目上下文并规划步骤…`,
        }),
      350,
    );

    if (turn === 1) {
      schedule(
        s,
        () =>
          pushEvent(sessionId, {
            kind: "tool-call",
            name: "read_file",
            summary: "读取 src/main.rs、Cargo.toml（模拟）",
          }),
        950,
      );
      schedule(
        s,
        () =>
          pushEvent(sessionId, {
            kind: "tool-call",
            name: "apply_patch",
            summary: "计划修改 3 个文件（模拟，未真正写入）",
          }),
        1550,
      );
      schedule(
        s,
        () => {
          const promptId = id();
          s.pendingPrompt = promptId;
          pushEvent(sessionId, {
            kind: "prompt",
            prompt_id: promptId,
            prompt_kind: "approval",
            question: `${agentLabel(
              s.meta.agent,
            )} 计划修改 3 个文件。是否允许执行？（真实 CLI 接入后，这里对应真实的工具审批）`,
            options: APPROVAL_OPTIONS,
          });
          setStatus(sessionId, "needs-input");
        },
        1950,
      );
    } else {
      schedule(
        s,
        () => {
          pushEvent(sessionId, {
            kind: "agent-message",
            text: "本轮任务已完成（桩模式）。接入真实 CLI 后，这里将是真实的执行结果。",
          });
          setStatus(sessionId, "completed");
        },
        850,
      );
    }
  },

  async answerPrompt(sessionId, promptId, answer) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("会话不存在");
    if (s.pendingPrompt !== promptId) throw new Error("提问不存在或已被回答");
    s.pendingPrompt = null;
    pushEvent(sessionId, { kind: "prompt-resolved", prompt_id: promptId, answer });
    setStatus(sessionId, "running");
    schedule(
      s,
      () => {
        const verdict =
          answer === "approve" || answer === "允许"
            ? "已按你的选择继续执行（模拟）。"
            : "已取消该操作（模拟）。";
        pushEvent(sessionId, {
          kind: "agent-message",
          text: `${verdict}\n\n${agentLabel(s.meta.agent)} 桩会话本轮结束。`,
        });
        setStatus(sessionId, "completed");
      },
      500,
    );
  },

  async stopSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.timers.forEach(clearTimeout);
    s.timers = [];
    s.pendingPrompt = null;
    setStatus(sessionId, "stopped");
  },

  async getSessionEvents(sessionId) {
    return [...(sessions.get(sessionId)?.events ?? [])];
  },

  async pickDirectory(title) {
    const input = window.prompt(
      `${title}（浏览器预览模式，手动输入路径）`,
      "/home/you/projects",
    );
    return input?.trim() || null;
  },
  async pickFiles() {
    const input = window.prompt(
      "添加附件（浏览器预览，多个路径用逗号分隔）",
      "",
    );
    if (!input?.trim()) return [];
    return input
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((path) => ({
        name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
        path,
      }));
  },

  onSessionEvent(cb) {
    eventListeners.add(cb);
    return () => eventListeners.delete(cb);
  },
  onSessionsChanged(cb) {
    sessionsChangedListeners.add(cb);
    return () => sessionsChangedListeners.delete(cb);
  },
  onProjectsChanged(cb) {
    projectsChangedListeners.add(cb);
    return () => projectsChangedListeners.delete(cb);
  },
};
