// 主区看什么：某个会话、某个项目（或独立聊天）的新会话、设置页。只是界面状态，业务数据在 daemon。

import { create } from "zustand";

/** 独立聊天不属于任何项目，用 null。 */
export type ProjectScope = string | null;

export type MainView =
  | { kind: "none" }
  | { kind: "task"; taskId: string; projectId: ProjectScope }
  | { kind: "new"; projectId: ProjectScope };

export type ProjectDialog = "create" | "import";

interface NavigationState {
  view: MainView;
  settings: boolean;
  projectDialog: ProjectDialog | null;
  /** 每个项目上次看的会话。回到这个项目时先落在它上面。 */
  lastTask: Record<string, string>;
}

const STANDALONE_KEY = "";

const scopeKey = (projectId: ProjectScope) => projectId ?? STANDALONE_KEY;

const useNavigationStore = create<NavigationState>()(() => ({
  view: { kind: "none" },
  settings: false,
  projectDialog: null,
  lastTask: {},
}));

export function useNavigation<T>(select: (state: NavigationState) => T): T {
  return useNavigationStore(select);
}

export function openTask(taskId: string, projectId: ProjectScope) {
  useNavigationStore.setState((state) => ({
    view: { kind: "task", taskId, projectId },
    settings: false,
    lastTask: { ...state.lastTask, [scopeKey(projectId)]: taskId },
  }));
}

export function openNewSession(projectId: ProjectScope) {
  useNavigationStore.setState({ view: { kind: "new", projectId }, settings: false });
}

/** 回到项目：上次看的会话还在就打开它，否则开新会话。 */
export function openProject(projectId: ProjectScope, existingTaskIds: readonly string[]) {
  const last = useNavigationStore.getState().lastTask[scopeKey(projectId)];
  if (last && existingTaskIds.includes(last)) openTask(last, projectId);
  else openNewSession(projectId);
}

/** 正在看的会话被删掉后，留在它所在的项目上。 */
export function leaveTask(taskId: string) {
  const view = useNavigationStore.getState().view;
  if (view.kind === "task" && view.taskId === taskId) openNewSession(view.projectId);
}

/** 项目被移除后，主区不再停在它上面。 */
export function leaveProject(projectId: string) {
  const view = useNavigationStore.getState().view;
  if (view.kind !== "none" && view.projectId === projectId) {
    useNavigationStore.setState({ view: { kind: "none" } });
  }
}

export function selectedProjectOf(view: MainView): ProjectScope | undefined {
  return view.kind === "none" ? undefined : view.projectId;
}

export function openSettings() {
  useNavigationStore.setState({ settings: true });
}

export function closeSettings() {
  useNavigationStore.setState({ settings: false });
}

export function openProjectDialog(mode: ProjectDialog) {
  useNavigationStore.setState({ projectDialog: mode });
}

export function closeProjectDialog() {
  useNavigationStore.setState({ projectDialog: null });
}
