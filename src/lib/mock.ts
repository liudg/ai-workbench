// 浏览器预览用的内存 mock 后端。
// 行为镜像 src-tauri 的适配器桩（stub.rs）：首轮消息演示工具调用 + 审批提问，
// 第二轮演示提问卡，之后轮次在思考和工具之间穿插，再流式写出结论。
// 让 UI 在没有 Rust 后端的浏览器里也能完整演示。

import {
  AGENT_LABELS,
  type AccessMode,
  type AgentCapabilities,
  type AgentCatalog,
  type AgentCatalogRefresh,
  type AgentInstallation,
  type CachedAgentCatalog,
  type AgentKind,
  type AgentProfile,
  type McpServerRecord,
  type Project,
  type PromptAnswer,
  type PromptOption,
  type QueuedTurn,
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
  { name: "/mcp", hint: "查看已连接的 MCP 服务器和工具", takes_args: true },
  { name: "/goal", hint: "设置、查看、暂停或清除任务目标", takes_args: true },
  { name: "/hooks", hint: "列出当前目录发现的钩子" },
  { name: "/worktree", hint: "查看或新建一个独立 Git 工作树", takes_args: true },
  { name: "/help", hint: "列出工作台能执行的斜杠命令" },
];

const CODEX_CAPABILITIES: AgentCapabilities = {
  supports_slash: true,
  supports_resume: true,
  supports_questions: true,
  supports_tuning: true,
  supports_skills: true,
  supports_mcp: true,
  supports_plugins: true,
  supports_hooks: true,
  supports_goals: true,
  supports_worktrees: true,
  supports_fork: true,
  supports_archive: true,
  supports_delete: true,
  supports_rename: true,
  supports_images: true,
  supports_queue: true,
};

const CLAUDE_CAPABILITIES: AgentCapabilities = {
  supports_slash: false,
  supports_resume: false,
  supports_questions: true,
  supports_tuning: false,
  supports_skills: false,
  supports_fork: false,
  supports_archive: false,
  supports_delete: false,
  supports_rename: false,
  supports_images: false,
  supports_queue: false,
};

const STUB_CAPABILITIES: AgentCapabilities = CLAUDE_CAPABILITIES;

function stubProfile(kind: AgentKind): AgentProfile {
  return { kind, capabilities: STUB_CAPABILITIES, commands: [] };
}

type PreviewAgents = "one" | "none" | "many" | "current";

/** 浏览器预览没有本机 PATH。`?agents=` 切换探测结果，方便看设置页和空选择器。 */
function previewAgents(): PreviewAgents {
  const value = new URLSearchParams(window.location.search).get("agents");
  if (value === "none" || value === "many" || value === "current" || value === "one") {
    return value;
  }
  return "one";
}

const STUB_DETAIL = "会话协议尚未接入，目前只做检测和更新。工作台不代为安装。";

const GEMINI_NOTE =
  "Gemini CLI（gemini）已于 2026-06-18 停更，官方后继是 Antigravity CLI。优先识别 agy，其次 antigravity，最后才是仍留在 PATH 上的 gemini。只找到 gemini 时不在应用内更新。";

const KIRO_NOTE =
  "Kiro CLI 是 Amazon Q Developer CLI 的后继。官方入口是 kiro-cli，q 仍是兼容入口。无关的 q 只有在版本输出里出现 Kiro 或 Amazon Q，或首行是 q 1.2.3 这种官方短版本时才算已安装。更新用 kiro-cli update --non-interactive；只找到旧的 q 时用 q update。";

function previewDetail(row: (typeof PREVIEW_ROWS)[number]): string | null {
  if (row.kind === "codex-cli" || row.kind === "claude-code") return null;
  return row.note ? `${row.note} ${STUB_DETAIL}` : STUB_DETAIL;
}

const PREVIEW_ROWS: Array<{
  kind: AgentKind;
  display_name: string;
  note: string | null;
}> = [
  { kind: "codex-cli", display_name: "Codex CLI", note: null },
  { kind: "claude-code", display_name: "Claude Code", note: null },
  { kind: "cursor-agent", display_name: "Cursor Agent", note: null },
  { kind: "copilot-cli", display_name: "GitHub Copilot CLI", note: null },
  { kind: "kimi-code", display_name: "Kimi Code", note: null },
  { kind: "qwen-code", display_name: "Qwen Code", note: null },
  { kind: "opencode", display_name: "OpenCode", note: null },
  { kind: "goose", display_name: "Goose", note: null },
  { kind: "antigravity", display_name: "Antigravity", note: GEMINI_NOTE },
  { kind: "kiro-cli", display_name: "Kiro CLI", note: KIRO_NOTE },
];

function absentRow(row: (typeof PREVIEW_ROWS)[number]): AgentInstallation {
  return {
    kind: row.kind,
    display_name: row.display_name,
    installed: false,
    version: null,
    latest_version: null,
    update_available: false,
    update_via: null,
    detail: previewDetail(row),
  };
}

function previewInstallations(mode: PreviewAgents): AgentInstallation[] {
  const codexInstalled = mode !== "none";
  const codexUpdate = mode === "one";
  const many = mode === "many";
  return PREVIEW_ROWS.map((row) => {
    if (row.kind === "codex-cli") {
      return {
        ...absentRow(row),
        installed: codexInstalled,
        version: !codexInstalled ? null : codexUpdate ? "0.160.0" : "0.162.0",
        latest_version: codexInstalled ? "0.162.0" : null,
        update_available: codexUpdate,
        update_via: codexInstalled ? "npm" : null,
      };
    }
    if (row.kind === "claude-code" && many) {
      return {
        ...absentRow(row),
        installed: true,
        version: "2.1.200",
        latest_version: "2.1.292",
        update_available: true,
        update_via: "cli",
      };
    }
    if (many && (row.kind === "cursor-agent" || row.kind === "copilot-cli" || row.kind === "kiro-cli")) {
      return {
        ...absentRow(row),
        installed: true,
        version: row.kind === "cursor-agent" ? "2026.10.01" : "1.0.82",
        latest_version: null,
        update_available: true,
        update_via: "cli",
        detail: previewDetail(row),
      };
    }
    return absentRow(row);
  });
}

let mockInstallations = previewInstallations(previewAgents());

let mockMcp: McpServerRecord[] = [
  {
    name: "context7",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    url: "",
    enabled: true,
    auth_status: "unsupported",
    runtime_status: "connected",
    tool_names: ["resolve-library-id", "query-docs"],
    tools_error: "",
    plugin_id: "",
  },
  {
    name: "figma",
    transport: "http",
    command: "",
    args: [],
    url: "https://mcp.figma.com/mcp",
    enabled: true,
    auth_status: "notLoggedIn",
    runtime_status: "authenticationRequired",
    tool_names: [],
    tools_error: "",
    plugin_id: "",
  },
];

/** 浏览器预览镜像后端 `agent_profiles`：按 Agent 给能力，而不是全局斜杠表。 */
const MOCK_PROFILES: Record<AgentKind, AgentProfile> = {
  "codex-cli": {
    kind: "codex-cli",
    capabilities: CODEX_CAPABILITIES,
    commands: CODEX_COMMANDS,
  },
  "claude-code": stubProfile("claude-code"),
  "cursor-agent": stubProfile("cursor-agent"),
  "copilot-cli": stubProfile("copilot-cli"),
  "kimi-code": stubProfile("kimi-code"),
  "qwen-code": stubProfile("qwen-code"),
  opencode: stubProfile("opencode"),
  goose: stubProfile("goose"),
  antigravity: stubProfile("antigravity"),
  "kiro-cli": stubProfile("kiro-cli"),
};

function previewCatalog(agent: AgentKind): AgentCatalog {
  const profile = MOCK_PROFILES[agent];
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
}

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
const queueListeners = new Set<Listener<{ session_id: string; items: QueuedTurn[] }>>();
const queuedTurns = new Map<string, QueuedTurn[]>();
const holdQueue = new Set<string>();
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
  }
  eventListeners.forEach((cb) => cb(event));
  if (body.kind === "status-changed") {
    sessionsChangedListeners.forEach((cb) => cb(s.meta.project_id));
  }
}

function noteActivity(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.meta.updated_at = now();
  sessionsChangedListeners.forEach((cb) => cb(s.meta.project_id));
}

function publishQueue(sessionId: string) {
  const items = (queuedTurns.get(sessionId) ?? []).map((item) => ({
    ...item,
    images: [...(item.images ?? [])],
  }));
  queueListeners.forEach((cb) => cb({ session_id: sessionId, items }));
}

function setStatus(sessionId: string, status: SessionStatus) {
  const prev = sessions.get(sessionId)?.meta.status;
  pushEvent(sessionId, { kind: "status-changed", status });
  if (status !== "completed" || prev !== "running" || holdQueue.has(sessionId)) return;
  const list = queuedTurns.get(sessionId) ?? [];
  const next = list.shift();
  queuedTurns.set(sessionId, list);
  publishQueue(sessionId);
  if (next) void mockBackend.sendMessage(sessionId, next.text, next.images ?? []);
}

/** 同一条事件反复推送，模拟 stream_id 覆盖（事件条数不变，正文变长）。 */
function upsertEvent(sessionId: string, eventId: string, body: SessionEventBody) {
  const s = sessions.get(sessionId);
  if (!s) return;
  const index = s.events.findIndex((event) => event.id === eventId);
  const event: SessionEvent =
    index >= 0
      ? { ...s.events[index], ...body, id: eventId }
      : {
          id: eventId,
          session_id: sessionId,
          seq: s.events.length + 1,
          ts: now(),
          ...body,
        };
  if (index >= 0) s.events[index] = event;
  else s.events.push(event);
  eventListeners.forEach((cb) => cb(event));
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
      archived: false,
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
        kind: "agent-message",
        text: "我会查看目录结构和最近改动。",
        phase: "commentary",
      });
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
      text: index === 0 ? PREVIEW_ANSWER : "这是工作台已注册项目下的预览会话。",
      phase: "final-answer",
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

const PREVIEW_ANSWER = `\`mercury_ai\` 是一个用 **Unity 2021.3.18f1c1、C#** 开发的战斗 AI 行为树编辑器。策划人员可以通过创建节点、填写参数、连接节点来配置角色或怪物的战斗行为，保存后生成供游戏使用的 JSON 数据。

项目现有配置涉及星宿、助战、宠物、主线战斗、副本、爬塔和世界妖王等内容。

**功能**

- **行为编排**：支持基础动作、执行子树、执行其他 AI，以及顺序、选择、并行、随机和集合遍历节点。
- **条件与目标处理**：支持条件检查、目标过滤、目标选择、目标集合检查和重复目标过滤。
- **辅助计算**：支持变量设置、战斗单位集合创建、排序、选择和集合运算。
- **编辑操作**：提供配置列表、名称搜索、新建、重命名、删除、节点复制粘贴和撤销功能。
- **连接检查**：限制根节点数量，并检查节点连接是否合法。

动作、条件、目标过滤、目标选择和触发点的具体选项由配置表提供，参数控件也根据表中定义生成。

**目录与代码职责**

| 路径 | 内容 |
| --- | --- |
| \`Assets/Scripts/CodeV_AI/Editor\` | AI 编辑器窗口、业务节点、参数控件、配置表读取和导出逻辑 |
| \`Assets/Scripts/CodeV_AI/Runtime/NodeData\` | 动作、条件、组合、装饰和辅助节点的数据结构 |
| \`Assets/ThirdParty/AI/FNode\` | 通用节点图框架，负责节点、连线、序列化和编辑历史 |
| \`Assets/ThirdParty/AI/VisualAssets\` | 编辑器的 UXML 布局和样式资源 |
| \`Assets/ThirdParty/AI/Export/Graph_Unity\` | 可继续编辑的行为树 JSON，当前有 198 个文件 |
| \`AIInput_Dev\` | 配置表输入，当前有 428 个 \`bytes\` 文件；代码直接读取其中五类 AI 表 |
| \`AIOutput\` | 导出的行为树 JSON，当前有 194 个文件 |

界面主要使用 **UI Toolkit 和 GraphView**，部分窗口使用 **Odin Inspector**。JSON 序列化使用 **Newtonsoft.Json**，二进制配置表通过 **Luban 的 ByteBuf** 读取。

**使用流程与代码入口**

在 Unity 菜单选择 **AI → 启动**，打开编辑器窗口。选择已有配置或新建配置，编辑节点和参数，通过“保存”或 \`Ctrl+S\` 保存图文件并导出到 \`AIOutput\`。文件命名采用 \`ai_{id}_{name}.json\`。

阅读代码可以从这些文件开始：

- [AIEditorWindow.cs](F:/mercury_resource/client/mercury_ai/Assets/Scripts/CodeV_AI/Editor/AIEditorWindow.cs)：窗口创建、文件列表、搜索、图加载和连接检查。
- [AIUtility.cs](F:/mercury_resource/client/mercury_ai/Assets/Scripts/CodeV_AI/Editor/Utility/AIUtility.cs)：文件路径、配置表加载、图保存和导出。
- [ConfigUtility.cs](F:/mercury_resource/client/mercury_ai/Assets/Scripts/CodeV_AI/Editor/Utility/ConfigUtility.cs)：五类 AI 配置表的查询接口。
- [EditorGraphUtility.cs](F:/mercury_resource/client/mercury_ai/Assets/ThirdParty/AI/FNode/FNode.Editor/Utilities/EditorGraphUtility.cs)：将编辑器节点和连线转换为导出数据。

![编辑器](F:/mercury_resource/client/mercury_ai/Temp/editor-preview.png)
`;

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

  async listSessions(projectId, archived = false) {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return [];
    const key = cwdKey(project.path);
    return [...sessions.values()]
      .filter((s) => cwdKey(s.cwd) === key && Boolean(s.meta.archived) === archived)
      .map((s) => ({ ...s.meta, project_id: project.id }))
      .sort((a, b) => b.updated_at - a.updated_at);
  },

  async forkSession(sessionId) {
    const source = sessions.get(sessionId);
    if (!source) throw new Error("会话不存在");
    if (!MOCK_PROFILES[source.meta.agent].capabilities.supports_fork) {
      throw new Error("不支持分叉聊天");
    }
    const nativeId = id();
    const createdId = `${source.meta.agent}:${nativeId}`;
    const meta: Session = {
      ...source.meta,
      id: createdId,
      native_id: nativeId,
      archived: false,
      status: "completed",
      created_at: now(),
      updated_at: now(),
    };
    sessions.set(createdId, {
      meta,
      cwd: source.cwd,
      events: source.events.map((event) => ({ ...event, id: id(), session_id: createdId })),
      turns: source.turns,
      pendingPrompt: null,
      access: source.access,
      timers: [],
    });
    sessionsChangedListeners.forEach((cb) => cb(source.meta.project_id));
    return { ...meta };
  },

  async renameSession(sessionId, name) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("会话不存在");
    const title = name.trim();
    if (!title) throw new Error("无法保存更改。请重试");
    if (!MOCK_PROFILES[s.meta.agent].capabilities.supports_rename) {
      throw new Error("不支持重命名聊天");
    }
    s.meta.title = title;
    sessionsChangedListeners.forEach((cb) => cb(s.meta.project_id));
  },

  async setSessionArchived(sessionId, archived) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("会话不存在");
    if (!MOCK_PROFILES[s.meta.agent].capabilities.supports_archive) {
      throw new Error("不支持归档聊天");
    }
    s.meta.archived = archived;
    sessionsChangedListeners.forEach((cb) => cb(s.meta.project_id));
  },

  async deleteSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("会话不存在");
    if (!MOCK_PROFILES[s.meta.agent].capabilities.supports_delete) {
      throw new Error("不支持永久删除");
    }
    s.timers.forEach(clearTimeout);
    sessions.delete(sessionId);
    sessionsChangedListeners.forEach((cb) => cb(s.meta.project_id));
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
      archived: false,
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
    if (!item?.installed || !item.update_available) {
      throw new Error("没有可安装的更新");
    }
    if (item.latest_version) item.version = item.latest_version;
    item.update_available = false;
    const row = PREVIEW_ROWS.find((item) => item.kind === kind);
    item.detail = row ? previewDetail(row) : null;
    return { ...item };
  },

  async cachedAgentCatalogs(): Promise<CachedAgentCatalog[]> {
    return [{ kind: "codex-cli", catalog: previewCatalog("codex-cli") }];
  },

  async agentCatalog(sessionId): Promise<AgentCatalogRefresh> {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("会话不存在");
    const catalog = previewCatalog(s.meta.agent);
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("catalog") === "fail") {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      throw new Error("等待 Codex model/list 超时");
    }
    return { catalog, notice: null };
  },

  async setSessionTuning() {},

  async setAccessMode(sessionId, mode) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("会话不存在");
    s.access = mode;
  },

  async sendMessage(sessionId, text, images = []) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("会话不存在");
    if (isReadOnlyOpen(s.events)) throw new Error(OCCUPIED_NOTICE);
    if (s.pendingPrompt) throw new Error("存在待回答的提问，请先处理");
    const profile = MOCK_PROFILES[s.meta.agent];
    const slash = text.trimStart().startsWith("/") && images.length === 0;
    if (profile.capabilities.supports_queue && s.meta.status === "running" && !slash) {
      const list = queuedTurns.get(sessionId) ?? [];
      list.push({ id: id(), text, images, client_id: id() });
      queuedTurns.set(sessionId, list);
      publishQueue(sessionId);
      return;
    }
    pushEvent(sessionId, {
      kind: "user-message",
      text,
      images,
    });
    noteActivity(sessionId);
    if (s.meta.title.startsWith("会话 ") || s.meta.title === "未命名会话") {
      const source = text.trim() || (images.length ? "图片" : "");
      if (source) {
        s.meta.title = source.split("\n")[0].slice(0, 24);
        sessionsChangedListeners.forEach((cb) => cb(s.meta.project_id));
      }
    }
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
      const answerId = id();
      const label = text.slice(0, 24);
      schedule(
        s,
        () =>
          pushEvent(sessionId, {
            kind: "agent-message",
            text: "我会查看相关入口。",
            phase: "commentary",
          }),
        200,
      );
      schedule(
        s,
        () =>
          pushEvent(sessionId, {
            kind: "thinking",
            text: `先对一下「${label}」的入口。`,
          }),
        250,
      );
      schedule(
        s,
        () =>
          pushEvent(sessionId, {
            kind: "tool-call",
            name: "command",
            summary: "rg --files\n已列出源码",
          }),
        550,
      );
      schedule(
        s,
        () =>
          pushEvent(sessionId, {
            kind: "thinking",
            text: `「${label}」的工具已经返回，结论还在写，这组调用先保持展开。`,
          }),
        900,
      );
      const parts = [
        `${label} 结论开头。`,
        `${label} 结论开头。\n\n第二段正在变长。`,
        `${label} 结论开头。\n\n第二段正在变长。\n\n第三段继续追加。`,
        `${label} 结论开头。\n\n第二段正在变长。\n\n第三段继续追加。\n\n第四段收尾。`,
      ];
      parts.forEach((text, index) => {
        schedule(
          s,
          () =>
            upsertEvent(sessionId, answerId, {
              kind: "agent-message",
              text,
              stream_id: "mock-answer",
              phase: "final-answer",
            }),
          1200 + index * 350,
        );
      });
      schedule(s, () => setStatus(sessionId, "completed"), 1200 + parts.length * 350);
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
    noteActivity(sessionId);
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
          phase: "final-answer",
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

  async listMcpServers() {
    return mockMcp.map((item) => ({ ...item, args: [...item.args], tool_names: [...item.tool_names] }));
  },
  async addMcpServer(input) {
    mockMcp = mockMcp.filter((item) => item.name !== input.name);
    mockMcp.push({
      name: input.name,
      transport: input.transport,
      command: input.transport === "stdio" ? input.commandLine : "",
      args: [],
      url: input.transport === "http" ? input.url : "",
      enabled: true,
      auth_status: input.transport === "http" ? "notLoggedIn" : "unsupported",
      runtime_status: "notStarted",
      tool_names: [],
      tools_error: "",
      plugin_id: "",
    });
  },
  async setMcpServerEnabled(name, enabled) {
    mockMcp = mockMcp.map((item) =>
      item.name === name
        ? { ...item, enabled, runtime_status: enabled ? item.runtime_status : "disabled" }
        : item,
    );
  },
  async removeMcpServer(name) {
    mockMcp = mockMcp.filter((item) => item.name !== name);
  },
  async loginMcpServer(name) {
    const server = mockMcp.find((item) => item.name === name);
    if (!server) throw new Error("找不到 MCP 服务器");
    server.auth_status = "oAuth";
    server.runtime_status = "connected";
    return { authorization_url: "https://example.com/oauth/mock" };
  },
  async reloadMcpServers() {
    return { warnings: [] };
  },
  async listPlugins() {
    return {
      marketplaces: [
        {
          name: "openai-bundled",
          display_name: "OpenAI",
          path: "",
          plugins: [
            {
              id: "browser@openai-bundled",
              name: "browser",
              display_name: "Browser",
              description: "Browse the web from Codex",
              developer: "OpenAI",
              marketplace_name: "openai-bundled",
              marketplace_path: "",
              installed: true,
              enabled: true,
              availability: "AVAILABLE",
              install_policy: "INSTALLED_BY_DEFAULT",
              source: "local",
              needs_install_confirm: false,
            },
            {
              id: "documents@openai",
              name: "documents",
              display_name: "Documents",
              description: "Create and edit documents",
              developer: "OpenAI",
              marketplace_name: "openai-bundled",
              marketplace_path: "",
              installed: false,
              enabled: false,
              availability: "AVAILABLE",
              install_policy: "AVAILABLE",
              source: "remote",
              needs_install_confirm: true,
            },
          ],
        },
      ],
      errors: [],
    };
  },
  async installPlugin(input) {
    void input;
  },
  async uninstallPlugin() {},
  async addMarketplace() {},
  async removeMarketplace() {},
  async upgradeMarketplace() {},
  async listHooks() {
    return [
      {
        cwd: "C:/repo",
        event_name: "preToolUse",
        handler: "echo review",
        source: "project",
        trust_status: "untrusted",
        enabled: true,
        status_message: "",
      },
    ];
  },
  async worktreeSettings() {
    return {
      root: "C:/Users/you/.codex/worktrees",
      keep: 15,
      auto_prune: true,
      worktrees: [
        {
          path: "C:/Users/you/.codex/worktrees/demo/1",
          head: "abc",
          branch: "",
          detached: true,
        },
      ],
    };
  },
  async saveWorktreeSettings(root, keep, autoPrune) {
    return { root, keep, auto_prune: autoPrune, worktrees: [] };
  },
  async createWorktree(projectPath) {
    return { path: `${projectPath}-worktree`, head: "", branch: "", detached: true };
  },
  async recycleWorktree() {},
  async addEnvironment(input) {
    return {
      id: input.environmentId,
      status: "pending",
      error: "",
      cwd: "",
      shell: "",
    };
  },
  async listEnvironments() {
    return [];
  },

  async pickDirectory(title) {
    const input = window.prompt(
      `${title}（浏览器预览模式，手动输入路径）`,
      "/home/you/projects",
    );
    return input?.trim() || null;
  },
  async updateQueuedTurn(sessionId, queuedId, text, images = []) {
    const list = queuedTurns.get(sessionId) ?? [];
    const item = list.find((row) => row.id === queuedId);
    if (!item) throw new Error("这条排队消息已经不在队列里");
    item.text = text;
    item.images = images;
    publishQueue(sessionId);
  },

  async removeQueuedTurn(sessionId, queuedId) {
    const list = queuedTurns.get(sessionId) ?? [];
    const next = list.filter((row) => row.id !== queuedId);
    if (next.length === list.length) throw new Error("这条排队消息已经不在队列里");
    queuedTurns.set(sessionId, next);
    publishQueue(sessionId);
  },

  async sessionQueue(sessionId) {
    return (queuedTurns.get(sessionId) ?? []).map((item) => ({
      ...item,
      images: [...(item.images ?? [])],
    }));
  },

  async interruptTurn(sessionId) {
    if (!sessions.has(sessionId)) throw new Error("会话不存在");
    holdQueue.add(sessionId);
    setStatus(sessionId, "completed");
    holdQueue.delete(sessionId);
  },

  async stageChatImage(dataBase64, name) {
    const src = dataBase64.startsWith("data:")
      ? dataBase64
      : `data:image/png;base64,${dataBase64}`;
    if (!/^data:image\//i.test(src)) throw new Error("只能附加图片");
    return { name: name || "image.png", path: src };
  },

  async pickImageFiles() {
    return this.pickFiles();
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
  onSessionQueue(cb) {
    queueListeners.add(cb);
    return () => queueListeners.delete(cb);
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
