// 与 `src-tauri/src/models/event.rs` 对应。`kind` 是判别标签。

import type { SessionStatus } from "./session.ts";

export type PromptKind = "approval" | "choice" | "free-text" | "questions" | "elicitation";

/**
 * 适配器标出的助手文本阶段。时间线只看这个字段，不比较 agent 种类。
 * 缺省表示协议没给阶段。
 */
export type MessagePhase = "commentary" | "partial-answer" | "final-answer";

/** 问题卡片中的一道题。适配器把原生提问映射进来；一轮可有多题。 */
export interface PromptQuestion {
  /** 阻塞式提问用上游 question id；async 提问按序合成 q1/q2… */
  id: string;
  /** 题目标签，可空 */
  header?: string;
  question: string;
  /** 敏感回答，输入时掩码 */
  is_secret: boolean;
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
}

/** 事件体（对应 Rust 的 SessionEventBody；适配器只产生这一层） */
export type SessionEventBody =
  | { kind: "user-message"; text: string; images?: string[]; annotations?: number }
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
    }
  | {
      kind: "prompt";
      prompt_id: string;
      prompt_kind: PromptKind;
      question: string;
      options: PromptOption[];
      /** prompt_kind === "questions" 时的逐题内容；其它类型为空 */
      questions: PromptQuestion[];
    }
  | { kind: "prompt-resolved"; prompt_id: string; answer: string }
  | { kind: "status-changed"; status: SessionStatus }
  | { kind: "system"; text: string }
  /** 线程被其他进程占用。历史已打开，输入框不可发送。 */
  | { kind: "read-only"; text: string }
  | { kind: "error"; message: string }
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
  /** 线程目标。objective 为空表示已清除。 */
  | { kind: "goal"; objective?: string | null; status?: string | null };

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
