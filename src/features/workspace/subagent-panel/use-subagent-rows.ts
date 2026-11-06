import { useMemo } from "react";

import { currentSession, useTasks, type TaskEntry, type TaskSession } from "@/features/tasks";
import { showError } from "@/shared/shell/error-banner";
import type { AgentProfile } from "@/types";
import { interruptTurn, stopSubagent } from "../session/api";
import { useTaskTimeline } from "../session/use-task-timeline";
import type { SubagentFocus } from "./open";
import { descendantTasks, nativeRow, subagentCards, taskRow, type SubagentRow } from "./subagent-rows";

export interface SubagentItem {
  row: SubagentRow;
  focus: SubagentFocus;
  /** 不能单独停时没有。 */
  stop?: () => void;
}

/**
 * 这个会话开出的所有子智能体：不管隔了几层的嵌套会话，和它自带的子 Agent。每行能停，也能全部停。
 * Agent 不能单独停子 Agent 时（适配器不声明 `supports_subagent_stop`），全部停就打断主回合，子 Agent 跟着停。
 */
export function useSubagentRows(task: TaskEntry, taskSession: TaskSession, profile: AgentProfile | undefined) {
  const { tasks } = useTasks();
  const events = useTaskTimeline(task, taskSession).all.events;
  const cards = useMemo(() => subagentCards(events), [events]);
  const canStopNative = Boolean(profile?.capabilities.supports_subagent_stop);
  const items = useMemo(() => {
    const nested = descendantTasks(tasks, task.id).flatMap((child): SubagentItem[] => {
      const session = currentSession(child);
      if (!session) return [];
      return [
        {
          row: taskRow(child, session.agent),
          focus: { kind: "task", taskId: child.id },
          stop: () => void interruptTurn(session.id).catch(showError),
        },
      ];
    });
    const native = cards.map(
      (card): SubagentItem => ({
        row: nativeRow(card, taskSession.agent),
        focus: { kind: "native", taskId: task.id, sessionId: card.session_id, subagentId: card.subagent_id },
        stop:
          canStopNative && card.session_id === taskSession.id
            ? () => void stopSubagent(card.session_id, card.subagent_id).catch(showError)
            : undefined,
      }),
    );
    return [...nested, ...native].sort((a, b) => a.row.since - b.row.since);
  }, [canStopNative, cards, task.id, taskSession.agent, taskSession.id, tasks]);

  const stopAll = () => {
    for (const { row, stop } of items) if (row.active) stop?.();
    // 子 Agent 只能跟着主回合停。
    if (!canStopNative && cards.some((card) => card.status === "running")) {
      void interruptTurn(taskSession.id).catch(showError);
    }
  };
  return { items, stopAll };
}
