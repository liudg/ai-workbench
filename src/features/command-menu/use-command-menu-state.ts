import { useMemo } from "react";

import { useAgentProfiles, useSessionAgents } from "@/features/agents";
import { usePanelOptional } from "@/features/panel/core/PanelProvider";
import { useProjects } from "@/features/projects";
import { currentSession, forkTargets as forkTargetsOf, useTasks, type ForkTarget } from "@/features/tasks";
import { attentionQueue, nextInQueue } from "@/shared/attention";
import { useNavigation } from "@/shared/shell/navigation";

import type { PaletteSession } from "./commands";

const UNTITLED = "";

/** 命令菜单要的数据：所有会话、正在看的会话和项目、当前的面板。展示组件只拿这里的结果。 */
export function useCommandMenuState() {
  const { tasks } = useTasks();
  const { projects } = useProjects();
  const view = useNavigation((state) => state.view);
  const profiles = useAgentProfiles();
  const panel = usePanelOptional();

  const sessions = useMemo<PaletteSession[]>(
    () =>
      tasks.map((task) => ({
        id: task.id,
        projectId: task.projectId ?? "",
        title: task.title.trim() || UNTITLED,
        archived: Boolean(task.archivedAt),
        updatedAt: task.updatedAt,
        pinned: task.pinned,
      })),
    [tasks],
  );
  const task = view.kind === "task" ? (tasks.find((item) => item.id === view.taskId) ?? null) : null;
  const nextAttention = useMemo(
    () => nextInQueue(attentionQueue(tasks.filter((item) => !item.archivedAt)), task?.id ?? null),
    [task, tasks],
  );
  const projectId = view.kind === "none" ? null : view.projectId;
  const project = projectId ? (projects.find((item) => item.id === projectId) ?? null) : null;
  const current = task ? currentSession(task) : undefined;
  const agent = current?.agent;
  const agents = useSessionAgents();
  const forkTargets = useMemo<ForkTarget[]>(
    () => forkTargetsOf(current, profiles, agents),
    [agents, current, profiles],
  );
  return {
    view,
    tasks,
    sessions,
    task,
    project,
    panel,
    forkTargets,
    nextAttention,
    changes: agent ? profiles[agent]?.capabilities.changes : undefined,
  };
}
