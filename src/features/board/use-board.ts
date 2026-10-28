import { useEffect, useMemo, useState } from "react";

import { useAgentProfiles } from "@/features/agents";
import { useProjects } from "@/features/projects";
import { currentSession, useTasks, type TaskEntry } from "@/features/tasks";
import { agentIdentity, type AgentIdentity } from "@/shared/agent/identity";
import { attentionPill, needsYou, type AttentionPillView } from "@/shared/attention";
import { closeBoard, openTask } from "@/shared/shell/navigation";
import { buildBoard, type BoardLane } from "./board-model";

export interface BoardCard {
  id: string;
  projectId?: string;
  title: string;
  archivedAt?: number;
  attention: TaskEntry["attention"];
  pill: AttentionPillView | null;
  identity: AgentIdentity | null;
  /** 项目名，独立聊天为空。 */
  place: string | null;
  branch: string | null;
}

const UNTITLED = "新会话";

/** 看板的列和卡片，点卡片打开那个会话。 */
export function useBoard() {
  const { tasks, loading } = useTasks();
  const { projects } = useProjects();
  const profiles = useAgentProfiles();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const lanes = useMemo<BoardLane<BoardCard>[]>(() => {
    const names = new Map(projects.map((project) => [project.id, project.name]));
    const cards = tasks.map((task): BoardCard => {
      const agent = currentSession(task)?.agent;
      return {
        id: task.id,
        projectId: task.projectId,
        title: task.title.trim() || UNTITLED,
        archivedAt: task.archivedAt,
        attention: task.attention,
        pill: attentionPill(task.attention),
        identity: agent ? agentIdentity(agent, profiles[agent]) : null,
        place: task.projectId ? (names.get(task.projectId) ?? null) : null,
        branch: task.workspace.kind === "worktree" ? task.workspace.branch : null,
      };
    });
    return buildBoard(cards);
  }, [projects, profiles, tasks]);

  return {
    lanes,
    loading,
    now,
    open: (card: BoardCard) => openTask(card.id, card.projectId ?? null),
    close: closeBoard,
  };
}

/** 等着你的会话有几个。侧栏的看板入口用。 */
export function useNeedsYouCount(): number {
  const { tasks } = useTasks();
  return useMemo(() => tasks.filter((task) => !task.archivedAt && needsYou(task.attention)).length, [tasks]);
}
