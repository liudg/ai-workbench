// 浏览器预览用的内存 mock 后端。
// 行为镜像 src-tauri 的适配器桩（stub.rs）：首轮消息演示工具调用 + 审批提问，
// 之后轮次直接完成。让 UI 在没有 Rust 后端的浏览器里也能完整演示。

import {
  AGENT_LABELS,
  type AccessMode,
  type AgentCapabilities,
  type AgentCatalog,
  type AgentInstallation,
  type AgentKind,
  type AgentProfile,
  type Project,
  type PromptAnswer,
  type PromptOption,
  type Session,
  type SessionEvent,
  type SessionEventBody,
  type SessionStatus,
  type SlashCommand,
} from "@/types";
import type {
  Backend,
  CreateProjectInput,
  CreateProjectResult,
  ImportProjectInput,
} from "./ipc";
import { slashPreview } from "./slash";
import { isReadOnlyOpen } from "./utils";

const OCCUPIED_NOTICE =
  "这个 Codex 会话正在被另一个进程占用，已只读打开。可以查看历史，不能在这里发送。";

const CODEX_COMMANDS: SlashCommand[] = [
  { name: "/permissions", hint: "切换完全访问、询问批准或只读", takes_args: true },
  { name: "/status", hint: "查看模型、线程、目录和权限" },
  { name: "/diff", hint: "查看 git diff --stat" },
  { name: "/review", hint: "请 Codex 审查当前工作区", takes_args: true },
  { name: "/plan", hint: "只出计划，不改文件", takes_args: true },
  { name: "/model", hint: "指定下一轮使用的模型", takes_args: true },
  { name: "/compact", hint: "压缩当前线程的上下文" },
  { name: "/approve", hint: "说明如何处理自动审查拒绝" },
  { name: "/init", hint: "生成 AGENTS.md" },
  { name: "/new", hint: "下一条消息开启新线程" },
  { name: "/clear", hint: "放下当前线程，同 /new" },
  { name: "/stop", hint: "停止当前会话" },
  { name: "/help", hint: "列出工作台能执行的斜杠命令" },
];

const CODEX_CAPABILITIES: AgentCapabilities = {
  supports_slash: true,
  supports_resume: true,
  supports_questions: true,
  supports_tuning: true,
  supports_skills: true,
};

const CLAUDE_CAPABILITIES: AgentCapabilities = {
  supports_slash: false,
  supports_resume: false,
  supports_questions: true,
  supports_tuning: false,
  supports_skills: false,
};

type PreviewAgents = "one" | "none" | "many" | "current";

/** 浏览器预览没有本机 PATH。`?agents=` 切换探测结果，方便看设置页和空选择器。 */
function previewAgents(): PreviewAgents {
  const value = new URLSearchParams(window.location.search).get("agents");
  if (value === "none" || value === "many" || value === "current" || value === "one") {
    return value;
  }
  return "one";
}

function previewInstallations(mode: PreviewAgents): AgentInstallation[] {
  const codexInstalled = mode !== "none";
  const codexUpdate = mode === "one";
  const claudeInstalled = mode === "many";
  return [
    {
      kind: "codex-cli",
      display_name: "Codex CLI",
      installed: codexInstalled,
      version: !codexInstalled ? null : codexUpdate ? "0.160.0" : "0.162.0",
      latest_version: codexInstalled ? "0.162.0" : null,
      update_available: codexUpdate,
      update_via: codexInstalled ? "npm" : null,
      detail: null,
    },
    {
      kind: "claude-code",
      display_name: "Claude Code",
      installed: claudeInstalled,
      version: claudeInstalled ? "2.1.200" : null,
      latest_version: claudeInstalled ? "2.1.292" : null,
      update_available: claudeInstalled,
      update_via: claudeInstalled ? "cli" : null,
      detail: null,
    },
  ];
}

let mockInstallations = previewInstallations(previewAgents());

/** 浏览器预览镜像后端 `agent_profiles`：按 Agent 给能力，而不是全局斜杠表。 */
const MOCK_PROFILES: Record<AgentKind, AgentProfile> = {
  "codex-cli": {
    kind: "codex-cli",
    capabilities: CODEX_CAPABILITIES,
    commands: CODEX_COMMANDS,
  },
  "claude-code": {
    kind: "claude-code",
    capabilities: CLAUDE_CAPABILITIES,
    commands: [],
  },
};

let seq = 0;
const id = () => `mock-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const now = () => Date.now();

interface MockSessionState {
  meta: Session;
  /** Agent 目录里的 cwd。列表按项目路径过滤，不按是否曾被工作台移除。 */
  cwd: string;
  events: SessionEvent[];
  turns: number;
  pendingPrompt: string | null;
  access: AccessMode;
  timers: ReturnType<typeof setTimeout>[];
}

function cwdKey(path: string) {
  return path.trim().replace(/[\\/]+$/, "").replace(/^\\\\\?\\/, "").toLowerCase();
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
  return AGENT_LABELS[agent];
}

function putSession(cwd: string, projectId: string, nativeId: string, title: string, updated: number) {
  const sessionId = `codex-cli:${nativeId}`;
  sessions.set(sessionId, {
    meta: {
      id: sessionId,
      project_id: projectId,
      agent: "codex-cli",
      native_id: nativeId,
      title,
      status: "completed",
      created_at: updated - 3_600_000,
      updated_at: updated,
    },
    cwd,
    events: [],
    turns: 1,
    pendingPrompt: null,
    access: "full",
    timers: [],
  });
  return sessionId;
}

/**
 * 浏览器预览没有本机 Agent 目录。这里只放一个已在工作台注册的项目，
 * 另有一条其它 cwd 的会话，不应出现在侧边栏。
 */
function seedRegisteredProject() {
  const projectId = "wb-mercury-dev";
  const path = "F:\\sample\\mercury_dev";
  projects.push({
    id: projectId,
    name: "mercury_dev",
    path,
    default_agent: "codex-cli",
    created_at: now() - 86_400_000,
    updated_at: now(),
    external: false,
  });
  const titles = [
    "确认线性渲染的 UI 校色",
    "分析大世界第三人称",
    "概括当前项目",
    "审查 GameMcp 修改",
    "核对存档迁移",
    "整理关卡脚本",
    "检查相机碰撞",
    "复盘昨日构建",
    "隐藏会话甲",
    "隐藏会话乙",
  ];
  titles.forEach((title, index) => {
    const updated = now() - index * 60_000;
    const sessionId = putSession(path, projectId, `preview-${index}`, title, updated);
    pushEvent(sessionId, { kind: "user-message", text: title });
    if (index === 2) {
      pushEvent(sessionId, {
        kind: "thinking",
        text: "先看目录结构和最近改动，再写概括。",
      });
      pushEvent(sessionId, {
        kind: "tool-call",
        name: "command",
        summary: "rg --files\n已列出源码",
      });
    }
    pushEvent(sessionId, {
      kind: "agent-message",
      text: "这是工作台已注册项目下的预览会话。",
    });
    if (index === 1) {
      pushEvent(sessionId, { kind: "read-only", text: OCCUPIED_NOTICE });
    }
  });
  putSession(
    "D:\\other\\not-in-workbench",
    "dir:d:\\other\\not-in-workbench",
    "unregistered",
    "不应出现的目录",
    now(),
  );
}

seedRegisteredProject();

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
    const project = projects.find((p) => p.id === projectId);
    const idx = projects.findIndex((p) => p.id === projectId);
    if (idx >= 0) projects.splice(idx, 1);
    if (project) {
      const key = cwdKey(project.path);
      for (const s of sessions.values()) {
        if (cwdKey(s.cwd) === key) {
          s.timers.forEach(clearTimeout);
          s.timers = [];
        }
      }
    }
    projectsChangedListeners.forEach((cb) => cb());
  },

  async listSessions(projectId) {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return [];
    const key = cwdKey(project.path);
    return [...sessions.values()]
      .filter((s) => cwdKey(s.cwd) === key)
      .map((s) => ({ ...s.meta, project_id: project.id }))
      .sort((a, b) => b.updated_at - a.updated_at);
  },

  async createSession(projectId, agent, accessMode) {
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new Error("项目不存在");
    const kind = agent ?? project.default_agent;
    const nativeId = id();
    const sessionId = `${kind}:${nativeId}`;
    const count = [...sessions.values()].filter(
      (s) => s.meta.project_id === projectId,
    ).length;
    const profile = MOCK_PROFILES[kind];
    const meta: Session = {
      id: sessionId,
      project_id: projectId,
      agent: kind,
      native_id: nativeId,
      title: profile.capabilities.supports_resume ? "未命名会话" : `会话 ${count + 1}`,
      status: "running",
      created_at: now(),
      updated_at: now(),
    };
    const state: MockSessionState = {
      meta,
      cwd: project.path,
      events: [],
      turns: 0,
      pendingPrompt: null,
      access: accessMode ?? "full",
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

  async agentProfiles() {
    return Object.values(MOCK_PROFILES);
  },

  async listAgentInstallations() {
    return mockInstallations.map((item) => ({ ...item }));
  },

  async updateAgent(kind) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const item = mockInstallations.find((row) => row.kind === kind);
    if (!item?.installed || !item.update_available || !item.latest_version) {
      throw new Error("没有可安装的更新");
    }
    item.version = item.latest_version;
    item.update_available = false;
    item.detail = null;
    return { ...item };
  },

  async agentCatalog(sessionId): Promise<AgentCatalog> {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("会话不存在");
    const profile = MOCK_PROFILES[s.meta.agent];
    if (!profile.capabilities.supports_tuning && !profile.capabilities.supports_skills) {
      return {
        models: [],
        skills: [],
        commands: profile.commands,
        capabilities: profile.capabilities,
      };
    }
    return {
      models: [
        {
          id: "gpt-6.1-sol",
          label: "GPT-6.1-Sol",
          description: "浏览器预览中的示例模型",
          is_default: true,
          default_effort: "medium",
          efforts: [
            { id: "low", description: "更快，推理更浅" },
            { id: "medium", description: "速度和深度均衡" },
            { id: "high", description: "更深的推理" },
          ],
        },
        {
          id: "gpt-6-astra",
          label: "GPT-6-Astra",
          description: "浏览器预览中的示例模型",
          is_default: false,
          default_effort: "high",
          efforts: [
            { id: "medium", description: "速度和深度均衡" },
            { id: "high", description: "更深的推理" },
          ],
        },
      ],
      skills: [
        {
          name: "documents:documents",
          mention: "documents",
          label: "Documents",
          description: "创建和编辑 Word 文档",
          path: "C:/skills/documents/SKILL.md",
        },
      ],
      commands: profile.commands,
      capabilities: profile.capabilities,
    };
  },

  async setSessionTuning() {},

  async setAccessMode(sessionId, mode) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("会话不存在");
    s.access = mode;
    pushEvent(sessionId, {
      kind: "system",
      text: `权限已设为${mode === "full" ? "完全访问" : mode === "ask" ? "询问批准" : "只读"}。浏览器预览不会把它交给 Codex。`,
    });
  },

  async sendMessage(sessionId, text) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("会话不存在");
    if (isReadOnlyOpen(s.events)) throw new Error(OCCUPIED_NOTICE);
    if (s.pendingPrompt) throw new Error("存在待回答的提问，请先处理");
    pushEvent(sessionId, {
      kind: "user-message",
      text,
    });
    if (s.meta.title.startsWith("会话 ") || s.meta.title === "未命名会话") {
      s.meta.title = text.split("\n")[0].slice(0, 24);
      sessionsChangedListeners.forEach((cb) => cb(s.meta.project_id));
    }
    if (text.includes("$documents")) {
      pushEvent(sessionId, {
        kind: "system",
        text: "已引用技能 Documents。",
      });
    }
    const profile = MOCK_PROFILES[s.meta.agent];
    if (profile.capabilities.supports_slash && text.trimStart().startsWith("/")) {
      if (text.trimStart().startsWith("/permissions")) {
        const arg = text.trim().split(/\s+/).slice(1).join(" ");
        if (arg === "完全访问" || arg === "full") s.access = "full";
        if (arg === "询问批准" || arg === "ask") s.access = "ask";
        if (arg === "只读" || arg === "read-only") s.access = "read-only";
      }
      pushEvent(sessionId, { kind: "system", text: slashPreview(profile.commands, text) });
      setStatus(sessionId, "completed");
      return;
    }
    s.turns += 1;
    const turn = s.turns;
    setStatus(sessionId, "running");

    schedule(
      s,
      () =>
        pushEvent(sessionId, {
          kind: "thinking",
          text: `先看「${text.slice(0, 48)}」涉及的入口和依赖，再决定要改哪些文件。`,
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
            questions: [],
          });
          setStatus(sessionId, "needs-input");
        },
        1950,
      );
    } else if (turn === 2) {
      // 第二轮：演示 Codex 原生问题卡片（一轮多题 + 编号选项 + 自由文本 + 跳过）
      schedule(
        s,
        () => {
          const promptId = id();
          s.pendingPrompt = promptId;
          pushEvent(sessionId, {
            kind: "prompt",
            prompt_id: promptId,
            prompt_kind: "questions",
            question: "想用哪个框架搭建新项目？",
            options: [],
            questions: [
              {
                id: "q1",
                question: "想用哪个框架搭建新项目？",
                is_secret: false,
                options: [
                  { id: "Vite", label: "Vite", description: "快速开发服务器，按需构建" },
                  { id: "Next.js", label: "Next.js", description: "React 全栈框架" },
                  { id: "Astro", label: "Astro", description: "内容驱动的静态站点" },
                ],
              },
              {
                id: "q2",
                question: "还有其他约束吗？",
                is_secret: false,
                options: [],
              },
            ],
          });
          setStatus(sessionId, "needs-input");
        },
        950,
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

  async answerPrompt(sessionId, promptId, answer: PromptAnswer) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("会话不存在");
    if (s.pendingPrompt !== promptId) throw new Error("提问不存在或已被回答");
    s.pendingPrompt = null;
    const promptEvent = s.events.find(
      (e): e is Extract<SessionEvent, { kind: "prompt" }> =>
        e.kind === "prompt" && e.prompt_id === promptId,
    );
    let summary: string;
    let approved = false;
    if (answer.type === "single") {
      summary = answer.value;
      approved = answer.value === "approve" || answer.value === "允许";
    } else if (answer.skipped) {
      summary = "已跳过";
    } else {
      const lines = (promptEvent?.questions ?? [])
        .map((q, i) => {
          const text = answer.answers[q.id]?.trim();
          return text ? `${i + 1}. ${text}` : null;
        })
        .filter((line): line is string => line !== null);
      summary = lines.length > 0 ? lines.join("\n") : "已跳过";
      approved = lines.length > 0;
    }
    pushEvent(sessionId, {
      kind: "prompt-resolved",
      prompt_id: promptId,
      answer: summary,
    });
    setStatus(sessionId, "running");
    schedule(
      s,
      () => {
        const verdict = approved
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
