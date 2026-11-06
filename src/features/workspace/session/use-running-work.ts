import { useMemo } from "react";

import { subagentDetail, subagentTitle, type SubagentEvent } from "@/features/chat/events/subagent-display";
import { subtaskDetail, subtaskStatus } from "@/features/chat/events/subtask-row";
import { currentSession, useTasks, type TaskEntry, type TaskSession } from "@/features/tasks";
import { showError } from "@/shared/shell/error-banner";
import { openSubagent, openTask } from "@/shared/shell/navigation";
import type { AgentKind, AgentProfile, SessionEvent } from "@/types";
import { interruptTurn, stopSubagent } from "./api";

/** 作曲栏上方「子任务和子 Agent」条里的一行。 */
export interface RunningItem {
  id: string;
  kind: "subtask" | "subagent";
  agent: AgentKind;
  title: string;
  /** 最后一句活动。 */
  detail: string;
  /** 状态字，等你的时候有颜色。 */
  status: string;
  statusClass: string;
  since: number | null;
  open: () => void;
  /** 不能单独停时没有。 */
  stop?: () => void;
}

/**
 * 这个会话下还在跑的子任务和 Agent 自带的子 Agent。照 orca
 * `src/renderer/src/components/native-chat/NativeChatBackgroundTasksStatus.tsx`：每行能停，也能全部停。
 * Agent 不能单独停子 Agent 时（适配器不声明 `supports_subagent_stop`），全部停就打断主回合，子 Agent 跟着停。
 */
export function useRunningWork(
  task: TaskEntry,
  taskSession: TaskSession,
  events: readonly SessionEvent[],
  profile: AgentProfile | undefined,
) {
  const { tasks } = useTasks();
  const children = tasks.filter(
    (item) =>
      item.parentTaskId === task.id &&
      !item.archivedAt &&
      (item.attention.state === "working" || item.attention.state === "needs-input"),
  );
  const childKey = children
    .map((item) => `${item.id}\u0000${item.title}\u0000${item.attention.state}\u0000${item.attention.ask ?? ""}\u0000${item.attention.preview ?? ""}\u0000${currentSession(item)?.updatedAt ?? 0}`)
    .join("\n");
  const cards = useMemo(() => runningCards(events, taskSession.id), [events, taskSession.id]);
  const canStopSubagent = Boolean(profile?.capabilities.supports_subagent_stop);
  const projectId = task.projectId ?? null;

  const items = useMemo<RunningItem[]>(() => {
    const subtaskItems = children.flatMap((child): RunningItem[] => {
      const session = currentSession(child);
      if (!session) return [];
      const status = subtaskStatus(child.attention);
      return [
        {
          id: child.id,
          kind: "subtask",
          agent: session.agent,
          title: child.title.trim() || "子任务",
          detail: subtaskDetail(child.attention),
          status: status.label,
          statusClass: status.running ? "text-[#8a8a8a]" : status.textClass,
          since: status.running ? session.updatedAt : null,
          open: () => openTask(child.id, child.projectId ?? null),
          stop: () => void interruptTurn(session.id).catch(showError),
        },
      ];
    });
    const subagentItems = cards.map(
      (card): RunningItem => ({
        id: card.subagent_id,
        kind: "subagent",
        agent: taskSession.agent,
        title: subagentTitle(card),
        detail: subagentDetail(card),
        status: "运行中",
        statusClass: "text-[#8a8a8a]",
        since: card.started_at ?? null,
        open: () => openSubagent(task.id, projectId, { sessionId: card.session_id, subagentId: card.subagent_id }),
        stop: canStopSubagent
          ? () => void stopSubagent(card.session_id, card.subagent_id).catch(showError)
          : undefined,
      }),
    );
    return [...subtaskItems, ...subagentItems];
    // 子任务按 childKey 里的字段比，任务列表本身每次都是新数组。
  }, [childKey, cards, canStopSubagent, projectId, task.id, taskSession.agent]);

  const stopAll = () => {
    for (const item of items) item.stop?.();
    // 子 Agent 只能跟着主回合停。
    if (!canStopSubagent && cards.length > 0) void interruptTurn(taskSession.id).catch(showError);
  };
  return { items, stopAll };
}

/** 这段会话里还在跑的子 Agent 卡片。之前几段会话（换过 Agent）的卡片已经跟着进程停了。 */
function runningCards(events: readonly SessionEvent[], sessionId: string): SubagentEvent[] {
  const latest = new Map<string, SubagentEvent>();
  for (const event of events) {
    if (event.kind === "subagent" && event.session_id === sessionId) latest.set(event.subagent_id, event);
  }
  return [...latest.values()].filter((card) => card.status === "running");
}
