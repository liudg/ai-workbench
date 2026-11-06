// 与 `crates/aiwb-core/src/models/event.rs` 对应。`kind` 是判别标签。

import type { AgentKind } from "./agent.ts";
import type { SessionStatus } from "./session.ts";

export type PromptKind = "approval" | "choice" | "free-text" | "questions" | "elicitation";

/**
 * 适配器标出的助手文本阶段。时间线只看这个字段，不比较 agent 种类。
 * 缺省表示协议没给阶段。
 */
export type MessagePhase = "commentary" | "partial-answer" | "final-answer";

/** 一条工具调用的进度。`running` 只在这一轮还在跑时才算真的在跑。 */
export type ToolStatus = "running" | "completed" | "failed";

/** Agent 自带的子 Agent 跑到哪了。 */
export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

/** 时间线里的一张子 Agent 卡片。同一个 `subagent_id` 的后一条整条替换前一条。 */
export interface SubagentCard {
  /** 派它的工具调用 id 或子线程 id。子 Agent 自己的步骤用它归属。 */
  subagent_id: string;
  /** 任务描述，可能为空。 */
  title: string;
  agent_type?: string;
  model?: string;
  effort?: string;
  /** 派给它的说明。 */
  prompt?: string;
  status: SubagentStatus;
  /** 在后台跑，主回合不等它。 */
  background?: boolean;
  /** 正在做什么，一句话。 */
  activity?: string;
  /** 交回来的结果。 */
  result?: string;
  tokens?: number;
  tool_uses?: number;
  /** 原生报的用时。没报时用起止时间算。 */
  duration_ms?: number;
  started_at?: number;
  ended_at?: number;
}

/** 提问卡片的按钮和占位。适配器写入，界面不看 Agent 名字。 */
export type QuestionSurface = "request-input" | "async-reply";

/** 问题卡片中的一道题。适配器把原生提问映射进来；一轮可有多题。 */
export interface PromptQuestion {
  /** 阻塞式提问用上游 question id；async 提问用协议合成 id */
  id: string;
  /** 题目标签，可空 */
  header?: string;
  question: string;
  /** 题下说明。没有就不显示。 */
  description?: string;
  /** Codex isSecret。这张卡不掩码。 */
  is_secret: boolean;
  /** 有选项时仍显示自定义输入。没有选项时自由输入不看这个字段。 */
  is_other?: boolean;
  /** 多选。缺省是单选。 */
  multi_select?: boolean;
  /** 缺省是阻塞式 request-input。 */
  surface?: QuestionSurface;
  /** 编号展示的选项；空数组 = 纯自由文本题。elicitation 的 enum 也放这里。 */
  options: PromptOption[];
  /** elicitation 字段类型：string / number / integer / boolean。 */
  input_kind?: string;
  /** elicitation 的 required。 */
  required?: boolean;
}

/** 对提问的回答：审批/单选/单行文本走 single；问题卡片走 questions */
export type PromptAnswer =
  | { type: "single"; value: string }
  | { type: "questions"; answers: Record<string, string>; skipped: boolean }
  | {
      type: "elicitation";
      action: "accept" | "decline" | "cancel";
      content?: Record<string, string | number | boolean>;
    };

export interface PromptOption {
  id: string;
  label: string;
  /** 选项说明，可空 */
  description?: string;
  /** 有值时不可选，值是原因。 */
  disabled_reason?: string | null;
  /** 审批卡位置：primary / deny / leading / scoped。空表示普通选项。 */
  slot?: string;
  /** 悬停说明。 */
  tooltip?: string;
}

/** 事件体（对应 Rust 的 SessionEventBody；适配器只产生这一层） */
export type SessionEventBody =
  | {
      kind: "user-message";
      text: string;
      images?: string[];
      annotations?: number;
      /** 工作台替子任务送来的回报或卡片结果，不是用户打的字。 */
      sender?: MessageSender;
    }
  | {
      kind: "agent-message";
      text: string;
      stream_id?: string;
      /** 过程旁白 / 部分答复 / 最终答复。缺省表示阶段未知。 */
      phase?: MessagePhase;
      /** 计划模式等由适配器标出。缺省表示不是计划模式。 */
      mode?: string;
      /** 与另一条事件重复。值为来源 id，例如审查结果的 item id。 */
      dedupe_of?: string;
    }
  | { kind: "thinking"; text: string; stream_id?: string }
  | {
      kind: "tool-call";
      name: string;
      summary: string;
      /** 命令输出、补丁正文、MCP 参数和结果。时间线默认折叠。 */
      detail?: string;
      stream_id?: string;
      images?: string[];
      /** 旧日志没有这个字段，按已结束读。 */
      status?: ToolStatus;
      /** 命令的退出码。协议没给就缺省。 */
      exit_code?: number;
    }
  | {
      kind: "prompt";
      prompt_id: string;
      prompt_kind: PromptKind;
      question: string;
      options: PromptOption[];
      /** prompt_kind === "questions" 时的逐题内容；其它类型为空 */
      questions: PromptQuestion[];
      /** 审批卡标题上方的类别 */
      header?: string;
      /** 标题下方的说明 */
      subtitle?: string;
      /** 命令或文件列表 */
      body?: string;
      /** command：三行折叠；files：可滚动列表 */
      body_kind?: string;
      /** 「原因」行 */
      reason?: string;
    }
  | { kind: "prompt-resolved"; prompt_id: string; answer: string }
  | { kind: "status-changed"; status: SessionStatus }
  | { kind: "system"; text: string }
  /** 线程被其他进程占用。历史已打开，输入框不可发送。 */
  | { kind: "read-only"; text: string }
  | { kind: "error"; message: string }
  /** 换 Agent 或分叉时把前文交给新 Agent。第一条消息发出后 `delivered` 为 true。 */
  | {
      kind: "handoff";
      from_agent: AgentKind;
      from_model?: string;
      to_agent: AgentKind;
      to_model?: string;
      strategy: "full" | "delta";
      delivered?: boolean;
      selected?: number;
      omitted?: number;
    }
  | { kind: "turn-anchor"; turn_id: string; mode?: string }
  | { kind: "turn-diff"; turn_id: string; diff: string }
  | {
      kind: "file-change";
      turn_id: string;
      path: string;
      status: FileStatus;
      added: number;
      removed: number;
      diff: string;
    }
  | { kind: "turn-changes"; turn_id: string; files: FileChange[] }
  | {
      kind: "plan-steps";
      turn_id: string;
      explanation?: string;
      steps: PlanStep[];
      mode?: string;
    }
  | { kind: "plan-text"; text: string; stream_id?: string; mode?: string }
  | { kind: "review-note"; text: string }
  | {
      kind: "review-findings";
      summary: string;
      findings: ReviewFinding[];
      raw: string;
    }
  | { kind: "collaboration-mode"; mode: string }
  /** Agent 开的子任务。`user_asked` 直接开出，带着 `accepted`；另外两种等用户在卡片上选，选过之后带 `resolution`。 */
  | {
      kind: "subtask-offer";
      offer_id: string;
      initiation: "user_asked" | "offer" | "own_initiative";
      subtasks: SubtaskSpec[];
      /** 过了这个时间（毫秒）就不能再点。 */
      expires_at?: number;
      resolution?: { kind: "accepted"; task_ids: string[] } | { kind: "declined" };
    }
  /** Agent 自带的子 Agent。同一个 `subagent_id` 整条替换。 */
  | ({ kind: "subagent" } & SubagentCard)
  /** 子 Agent 自己的一步。不进主时间线，挂在对应卡片下面。 */
  | { kind: "subagent-step"; subagent_id: string; step: SessionEventBody }
  /** 子 Agent 结束的那一刻。宿主在卡片结束时记，排在结束时的位置。 */
  | { kind: "subagent-ended"; subagent_id: string; title: string; status: SubagentStatus }
  /** 线程目标。objective 为空表示已清除。用量字段来自 `thread/goal`，没有就不编。 */
  | {
      kind: "goal";
      objective?: string | null;
      status?: string | null;
      token_budget?: number | null;
      tokens_used?: number | null;
      time_used_seconds?: number | null;
    }
  /** 上下文窗口或本回合 token。不进时间线。缺的数字不写，界面不补 0。 */
  | {
      kind: "context-usage";
      /** `get_context_usage` 是窗口，`partial-usage` 是本回合。 */
      source: string;
      used_tokens?: number | null;
      max_tokens?: number | null;
      percentage?: number | null;
      input_tokens?: number | null;
      output_tokens?: number | null;
      model?: string | null;
    }
  /** 当前会话 token 累计。不进时间线。`snapshot` 替换累计，`delta` 按 key 相加。 */
  | {
      kind: "session-usage";
      scope: string;
      key?: string | null;
      input_tokens?: number | null;
      output_tokens?: number | null;
      cache_read_tokens?: number | null;
      cache_write_tokens?: number | null;
    };

/** 工作台消息说的是哪些子任务。 */
export interface MessageSender {
  task_ids: string[];
}

export interface SubtaskSpec {
  agent: AgentKind;
  title: string;
  prompt: string;
  worktree?: boolean;
}

export type FileStatus = "A" | "M" | "D" | "R";

export interface FileChange {
  path: string;
  status: FileStatus;
  added: number;
  removed: number;
  diff: string;
}

export interface PlanStep {
  step: string;
  status: string;
}

export interface ReviewFinding {
  title: string;
  location: string;
  body: string;
}

export type ReviewStart =
  | { kind: "uncommitted" }
  | { kind: "base"; branch: string }
  | { kind: "commit"; sha: string; title?: string }
  | { kind: "custom"; instructions: string };

export interface ReviewCommit {
  sha: string;
  title: string;
}

/** 审查菜单各层文案，由适配器给出。 */
export interface ReviewLabels {
  title: string;
  base_branch: string;
  base_branch_hint: string;
  uncommitted: string;
  commit: string;
  custom: string;
  branch_title: string;
  branch_subtitle: string;
  branch_search: string;
  commit_title: string;
  commit_search: string;
  custom_placeholder: string;
}

export interface ReviewTargets {
  branches: string[];
  commits: ReviewCommit[];
  error?: string | null;
  current_branch?: string | null;
  labels: ReviewLabels;
}

/** 完整事件 = 事件体 + 信封（id / seq / ts 由 SessionManager 统一赋值） */
export type SessionEvent = {
  id: string;
  session_id: string;
  seq: number;
  ts: number;
} & SessionEventBody;

/** 内置浏览器批注。发送时由适配层折进回合，不绑某个 Agent。 */
export interface PageAnnotation {
  id: string;
  url: string;
  selector: string;
  text: string;
  comment: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: string;
  screenshot?: string;
  snapshotFailed?: boolean;
}
