import {
  SUBAGENT_STATUS_LABELS,
  subagentDetail,
  subagentTitle,
  subtaskDetail,
  subtaskStatus,
  type SubagentEvent,
} from "../../chat/headless.ts";
import type { AgentKind, SessionEvent } from "../../../types/index.ts";
import type { TaskEntry } from "../../tasks/index.ts";

/** 子智能体列表里的一行。 */
export interface SubagentRow {
  key: string;
  agent: AgentKind;
  title: string;
  /** 状态字和颜色。 */
  status: string;
  statusClass: string;
  /** 最后一句活动或结果。 */
  detail: string;
  /** 还在跑或在等你。 */
  active: boolean;
  /** 开始的时间，列表按它排。 */
  since: number;
}

/** 这个任务下的所有后代，不管隔了几层。 */
export function descendantTasks(tasks: readonly TaskEntry[], rootId: string): TaskEntry[] {
  const inTree = new Set([rootId]);
  const found: TaskEntry[] = [];
  for (let added = true; added; ) {
    added = false;
    for (const task of tasks) {
      if (task.parentTaskId && inTree.has(task.parentTaskId) && !inTree.has(task.id)) {
        inTree.add(task.id);
        if (!task.archivedAt) found.push(task);
        added = true;
      }
    }
  }
  return found;
}

export function taskRow(task: TaskEntry, agent: AgentKind): SubagentRow {
  const status = subtaskStatus(task.attention);
  return {
    key: `task:${task.id}`,
    agent,
    title: task.title.trim() || "子任务",
    status: status.label,
    statusClass: status.textClass,
    detail: subtaskDetail(task.attention),
    active: task.attention.state === "starting" || task.attention.state === "working" || task.attention.state === "needs-input",
    since: task.createdAt,
  };
}

export function nativeRow(card: SubagentEvent, agent: AgentKind): SubagentRow {
  return {
    key: `native:${card.session_id}:${card.subagent_id}`,
    agent,
    title: subagentTitle(card),
    status: SUBAGENT_STATUS_LABELS[card.status],
    statusClass: card.status === "failed" ? "text-wb-danger" : "text-wb-fg-3",
    detail: subagentDetail(card),
    active: card.status === "running",
    since: card.started_at ?? card.ts,
  };
}

/** 时间线里的子 Agent 卡片，同一个 id 只留最后一张。换过 Agent 时前面几段的也在。 */
export function subagentCards(events: readonly SessionEvent[]): SubagentEvent[] {
  const latest = new Map<string, SubagentEvent>();
  for (const event of events) {
    if (event.kind === "subagent") latest.set(`${event.session_id}:${event.subagent_id}`, event);
  }
  return [...latest.values()];
}
