// 侧边栏折叠与分页视图状态（项目折叠、独立聊天组折叠、每组展开条数、父任务的子任务折叠）。
// 提升到共享 store，供侧边栏渲染与 `Mod+1..9` / `Mod+Shift+[/]` 可见会话计算共用同一份状态。

import { create } from "zustand";

import { revealMoreSessions, SESSION_PREVIEW_LIMIT } from "./sessions/session-order.ts";

export interface SidebarViewState {
  collapsedProjects: ReadonlySet<string>;
  chatsCollapsed: boolean;
  visibleLimitByScope: Readonly<Record<string, number>>;
  collapsedSubtasks: ReadonlySet<string>;
}

interface SidebarViewActions {
  setProjectCollapsed: (projectId: string, collapsed: boolean) => void;
  toggleProjectCollapsed: (projectId: string) => void;
  toggleChatsCollapsed: () => void;
  revealMoreInScope: (scope: string) => void;
  collapseScopeLimit: (scope: string) => void;
  toggleSubtaskCollapsed: (taskId: string) => void;
}

export type SidebarViewStore = SidebarViewState & SidebarViewActions;

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_LIMITS: Readonly<Record<string, number>> = {};

export const DEFAULT_SIDEBAR_VIEW_STATE: SidebarViewState = {
  collapsedProjects: EMPTY_SET,
  chatsCollapsed: false,
  visibleLimitByScope: EMPTY_LIMITS,
  collapsedSubtasks: EMPTY_SET,
};

export function sidebarScopeKey(projectId: string | null | undefined): string {
  return projectId ? `project:${projectId}` : "chats";
}

export const useSidebarViewStore = create<SidebarViewStore>()((set) => ({
  ...DEFAULT_SIDEBAR_VIEW_STATE,

  setProjectCollapsed: (projectId, collapsed) =>
    set((state) => {
      if (state.collapsedProjects.has(projectId) === collapsed) return state;
      const next = new Set(state.collapsedProjects);
      if (collapsed) next.add(projectId);
      else next.delete(projectId);
      return { collapsedProjects: next };
    }),

  toggleProjectCollapsed: (projectId) =>
    set((state) => {
      const next = new Set(state.collapsedProjects);
      if (!next.delete(projectId)) next.add(projectId);
      return { collapsedProjects: next };
    }),

  toggleChatsCollapsed: () => set((state) => ({ chatsCollapsed: !state.chatsCollapsed })),

  revealMoreInScope: (scope) =>
    set((state) => {
      const current = state.visibleLimitByScope[scope] ?? SESSION_PREVIEW_LIMIT;
      return {
        visibleLimitByScope: {
          ...state.visibleLimitByScope,
          [scope]: revealMoreSessions(current),
        },
      };
    }),

  collapseScopeLimit: (scope) =>
    set((state) => {
      if (!(scope in state.visibleLimitByScope)) return state;
      const next = { ...state.visibleLimitByScope };
      delete next[scope];
      return { visibleLimitByScope: next };
    }),

  toggleSubtaskCollapsed: (taskId) =>
    set((state) => {
      const next = new Set(state.collapsedSubtasks);
      if (!next.delete(taskId)) next.add(taskId);
      return { collapsedSubtasks: next };
    }),
}));

export function getSidebarViewState(): SidebarViewState {
  const state = useSidebarViewStore.getState();
  return {
    collapsedProjects: state.collapsedProjects,
    chatsCollapsed: state.chatsCollapsed,
    visibleLimitByScope: state.visibleLimitByScope,
    collapsedSubtasks: state.collapsedSubtasks,
  };
}
