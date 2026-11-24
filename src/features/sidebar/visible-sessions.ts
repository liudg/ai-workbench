// 按侧边栏真实视觉顺序（置顶项目 -> 普通项目 -> 独立聊天，跳过折叠分组与已归档会话，应用分页与子任务折叠）
// 计算当前可见的会话列表。纯计算模块，零 daemon 副作用，可在 Node 单测中直接导入。

import type { Project } from "../projects/index.ts";
import type { TaskEntry } from "../tasks/index.ts";
import { splitPinnedProjects } from "./projects/project-sections.ts";
import { nestLines, splitSubtasks } from "./sessions/session-nesting.ts";
import { SESSION_PREVIEW_LIMIT, sidebarSessionWindow } from "./sessions/session-order.ts";
import { partitionSidebarSessions } from "./sessions/session-partition.ts";
import { sidebarTask, type SidebarTask } from "./sidebar-task.ts";
import {
  DEFAULT_SIDEBAR_VIEW_STATE,
  sidebarScopeKey,
  type SidebarViewState,
} from "./sidebar-view-store.ts";

export type ProjectSummary = Pick<Project, "id" | "pinned">;

function isTaskEntry(item: SidebarTask | TaskEntry): item is TaskEntry {
  return "sessions" in item;
}

function toSidebarTask(item: SidebarTask | TaskEntry): SidebarTask {
  return isTaskEntry(item) ? sidebarTask(item) : item;
}

function visibleScopeLines(
  tasks: readonly SidebarTask[],
  scope: string,
  viewState: SidebarViewState,
): SidebarTask[] {
  const { active } = partitionSidebarSessions(tasks);
  if (active.length === 0) return [];
  const { roots, childrenOf } = splitSubtasks(active);
  const pinnedIds = roots.filter((task) => task.pinned).map((task) => task.id);
  const visibleLimit = viewState.visibleLimitByScope[scope] ?? SESSION_PREVIEW_LIMIT;
  const { visible } = sidebarSessionWindow(roots, visibleLimit, pinnedIds);
  const lines = nestLines(visible, childrenOf, viewState.collapsedSubtasks);
  return lines.map((line) => line.task);
}

export function visibleTasksFromSections(
  sections: {
    pinned: readonly Pick<ProjectSummary, "id">[];
    unpinned: readonly Pick<ProjectSummary, "id">[];
    tasksOf: (projectId: string | null) => readonly SidebarTask[];
  },
  viewState: SidebarViewState = DEFAULT_SIDEBAR_VIEW_STATE,
): SidebarTask[] {
  const ordered: SidebarTask[] = [];

  for (const project of sections.pinned) {
    if (viewState.collapsedProjects.has(project.id)) continue;
    const projectTasks = sections.tasksOf(project.id);
    if (projectTasks.length === 0) continue;
    ordered.push(...visibleScopeLines(projectTasks, sidebarScopeKey(project.id), viewState));
  }

  for (const project of sections.unpinned) {
    if (viewState.collapsedProjects.has(project.id)) continue;
    const projectTasks = sections.tasksOf(project.id);
    if (projectTasks.length === 0) continue;
    ordered.push(...visibleScopeLines(projectTasks, sidebarScopeKey(project.id), viewState));
  }

  if (!viewState.chatsCollapsed) {
    const standaloneTasks = sections.tasksOf(null);
    if (standaloneTasks.length > 0) {
      ordered.push(...visibleScopeLines(standaloneTasks, sidebarScopeKey(null), viewState));
    }
  }

  return ordered;
}

export function computeVisibleSidebarTasks(
  projects: readonly ProjectSummary[],
  tasks: readonly (SidebarTask | TaskEntry)[],
  viewState: SidebarViewState = DEFAULT_SIDEBAR_VIEW_STATE,
): SidebarTask[] {
  const byProject = new Map<string | null, SidebarTask[]>();
  for (const raw of tasks) {
    const row = toSidebarTask(raw);
    const key = row.projectId ?? null;
    const list = byProject.get(key);
    if (list) list.push(row);
    else byProject.set(key, [row]);
  }

  const pinnedProjectIds = projects.filter((project) => project.pinned).map((project) => project.id);
  const sections = splitPinnedProjects(projects, pinnedProjectIds);
  const empty: readonly SidebarTask[] = [];
  return visibleTasksFromSections(
    {
      pinned: sections.pinned,
      unpinned: sections.unpinned,
      tasksOf: (projectId) => byProject.get(projectId) ?? empty,
    },
    viewState,
  );
}

/** 在可见会话列表中按上/下一条切换（首尾回绕）。 */
export function stepVisibleSidebarTask(
  visibleTasks: readonly SidebarTask[],
  activeTaskId: string | null,
  direction: -1 | 1,
): SidebarTask | null {
  if (visibleTasks.length === 0) return null;
  const currentIndex = activeTaskId ? visibleTasks.findIndex((task) => task.id === activeTaskId) : -1;
  if (currentIndex < 0) {
    return direction === 1 ? visibleTasks[0] : visibleTasks[visibleTasks.length - 1];
  }
  const nextIndex = (currentIndex + direction + visibleTasks.length) % visibleTasks.length;
  return visibleTasks[nextIndex] ?? null;
}
