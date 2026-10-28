import { useMemo } from "react";

import { useAgentProfiles, useSessionAgents } from "@/features/agents";
import { usePanelOptional } from "@/features/panel/core/PanelProvider";
import { useProjects } from "@/features/projects";
import { currentSession, useTasks } from "@/features/tasks";
import { attentionQueue, nextInQueue } from "@/shared/attention";
import { useNavigation } from "@/shared/shell/navigation";

import type { ForkTarget, PaletteSession } from "./commands";

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
  const forkTargets = useMemo<ForkTarget[]>(() => {
    if (!current || current.status === "running" || current.status === "needs-input") return [];
    const caps = (kind: typeof current.agent) => profiles[kind]?.capabilities;
    const handsOff = (kind: typeof current.agent) => caps(kind)?.supports_context_handoff === true;
    const name = (kind: typeof current.agent, fallback: string) => profiles[kind]?.display_name || fallback;
    const targets: ForkTarget[] = [];
    // 同一个 Agent：有原生线程时原生分叉，否则和换 Agent 一样交前文。
    const native = Boolean(current.nativeId) && caps(current.agent)?.supports_fork === true;
    if (native || handsOff(current.agent)) {
      targets.push({ agent: current.agent, name: name(current.agent, current.agent), same: true });
    }
    if (handsOff(current.agent)) {
      for (const item of agents ?? []) {
        if (item.kind !== current.agent && handsOff(item.kind)) {
          targets.push({ agent: item.kind, name: name(item.kind, item.display_name), same: false });
        }
      }
    }
    return targets;
  }, [agents, current, profiles]);
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
