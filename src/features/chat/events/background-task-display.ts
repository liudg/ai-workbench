import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import type { SessionEvent } from "../../../types/index.ts";
import { activityStepTitle, type ToolCallEvent } from "./activity-fold.ts";

/**
 * 后台任务的纯数据投影。界面只读事件字段和适配器能力，不比较 Agent 种类。
 */

export type BackgroundTaskEvent = Extract<SessionEvent, { kind: "background-task" }>;

const EMPTY_TASKS: readonly BackgroundTaskEvent[] = [];
const EMPTY_BG_BY_TOOL: ReadonlyMap<string, BackgroundTaskEvent> = new Map();

export function toolStreamKey(sessionId: string, streamId: string): string {
  return `${sessionId}:${streamId.trim()}`;
}

export function linkedToolForTask(
  task: BackgroundTaskEvent,
  toolsByStream: ReadonlyMap<string, ToolCallEvent>,
): ToolCallEvent | undefined {
  const callId = task.tool_call_id?.trim();
  return callId ? toolsByStream.get(toolStreamKey(task.session_id, callId)) : undefined;
}

/** 时间线里的后台任务，同一个 `task_id` 只留最后一条，保持首次出现的顺序。没有时返回稳定空数组。 */
export function backgroundTasks(events: readonly SessionEvent[]): readonly BackgroundTaskEvent[] {
  let latest: Map<string, BackgroundTaskEvent> | null = null;
  for (const event of events) {
    if (event.kind === "background-task") {
      latest ??= new Map();
      latest.set(`${event.session_id}:${event.task_id}`, event);
    }
  }
  return latest ? [...latest.values()] : EMPTY_TASKS;
}

/** 按关联的工具卡片（`session_id:tool_call_id`）索引后台任务。没有时返回稳定空 Map。 */
export function backgroundTasksByToolCall(
  events: readonly SessionEvent[],
): ReadonlyMap<string, BackgroundTaskEvent> {
  const tasks = backgroundTasks(events);
  if (tasks.length === 0) return EMPTY_BG_BY_TOOL;
  let map: Map<string, BackgroundTaskEvent> | null = null;
  for (const task of tasks) {
    const callId = task.tool_call_id?.trim();
    if (callId) {
      map ??= new Map();
      map.set(toolStreamKey(task.session_id, callId), task);
    }
  }
  return map ?? EMPTY_BG_BY_TOOL;
}

/** 按 `session_id:stream_id` 索引工具调用，给胶囊浮层查关联命令和流式输出。 */
export function toolCallsByStreamId(
  events: readonly SessionEvent[],
): ReadonlyMap<string, ToolCallEvent> {
  const map = new Map<string, ToolCallEvent>();
  for (const event of events) {
    const streamId = event.kind === "tool-call" ? event.stream_id?.trim() : undefined;
    if (event.kind === "tool-call" && streamId) {
      map.set(toolStreamKey(event.session_id, streamId), event);
    }
  }
  return map;
}

/** 单行标题：优先任务说明，其次关联工具命令（剥掉外层 shell 包装并简化相对路径），再兜底为「后台任务」。 */
export function backgroundTaskTitle(
  task: BackgroundTaskEvent,
  linkedTool?: ToolCallEvent,
  projectPath = "",
): string {
  const raw = (task.title.trim() || linkedTool?.summary.trim() || "").replace(/\s+/g, " ").trim();
  if (!raw) return DESKTOP_ZH.backgroundTasks;
  return activityStepTitle("command", raw, projectPath);
}

/** 失败文案：有退出码写退出码，没有写「失败」。 */
export function backgroundFailureText(exitCode?: number | null): string {
  if (exitCode != null) return DESKTOP_ZH.toolExitCode.replace("{code}", String(exitCode));
  return DESKTOP_ZH.toolFailed;
}

/** 统一生成后台任务行的状态字。 */
export function backgroundStatusLabel(
  task: BackgroundTaskEvent,
  formattedElapsed?: string | null,
): string {
  if (task.status === "running") {
    return formattedElapsed || DESKTOP_ZH.backgroundRunning;
  }
  if (task.status === "stopped") return DESKTOP_ZH.backgroundStopped;
  if (task.status === "failed") return backgroundFailureText(task.exit_code);
  return DESKTOP_ZH.backgroundCompleted;
}

/** 工具把命令转入后台时留下的固定启动占位文案，不算真正的命令输出。 */
export function isBackgroundLaunchPlaceholder(text: string): boolean {
  return /^(?:Command running in background with ID:|Tool is running as a background task with task id:)/i.test(
    text.trim(),
  );
}

/**
 * 统一解析后台任务的输出文本（不看 Agent 种类）：
 * 1. `output_file` 读出来的正文；
 * 2. 关联 `tool-call` 上的流式或最终 `detail`（排除转入后台时的启动占位句）；
 * 3. 任务结束时附带的 `result` 摘要（排除仅仅原样重复任务标题的回执）。
 */
export function resolveBackgroundOutput(input: {
  detail?: string;
  fileText?: string;
  result?: string;
  rawTitle?: string;
}): string {
  const file = input.fileText?.replace(/\r\n/g, "\n") ?? "";
  if (file.trim().length > 0) return file.trimEnd();
  const detail = input.detail ?? "";
  if (detail.trim().length > 0 && !isBackgroundLaunchPlaceholder(detail)) {
    return detail.trimEnd();
  }
  const result = input.result?.trim() ?? "";
  if (result.length > 0 && result !== (input.rawTitle?.trim() ?? "")) return result;
  return "";
}

/**
 * 胶囊浮层里要列出的任务：平时只认还在跑的；浮层打开期间结束的任务先留着，
 * 避免用户正在看输出或刚点停止时整行突然消失，关掉浮层后再收起。
 */
export function visiblePillTasks(
  tasks: readonly BackgroundTaskEvent[],
  pinnedIds: ReadonlySet<string>,
  open: boolean,
): BackgroundTaskEvent[] {
  if (!open) return tasks.filter((task) => task.status === "running");
  return tasks.filter((task) => task.status === "running" || pinnedIds.has(task.task_id));
}
