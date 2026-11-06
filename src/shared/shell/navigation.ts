// 主区看什么：某个会话、某个项目（或独立聊天）的新会话、设置页、看板。只是界面状态，业务数据在 daemon。

import { create } from "zustand";

/** 独立聊天不属于任何项目，用 null。 */
export type ProjectScope = string | null;

export type MainView =
  | { kind: "none" }
  | { kind: "task"; taskId: string; projectId: ProjectScope; subagent?: SubagentRef }
  | { kind: "new"; projectId: ProjectScope };

/** 会话里 Agent 自带的一个子 Agent：写下它的那段会话和卡片 id。 */
export interface SubagentRef {
  sessionId: string;
  subagentId: string;
}

export type ProjectDialog = "create" | "import";

interface NavigationState {
  view: MainView;
  settings: boolean;
  /** 看板盖在主区上，关掉回到原来的会话。 */
  board: boolean;
  projectDialog: ProjectDialog | null;
  /** 每个项目上次看的会话。回到这个项目时先落在它上面。 */
  lastTask: Record<string, string>;
}

const STANDALONE_KEY = "";

const scopeKey = (projectId: ProjectScope) => projectId ?? STANDALONE_KEY;

const useNavigationStore = create<NavigationState>()(() => ({
  view: { kind: "none" },
  settings: false,
  board: false,
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
    board: false,
    lastTask: { ...state.lastTask, [scopeKey(projectId)]: taskId },
  }));
}

export function openNewSession(projectId: ProjectScope) {
  useNavigationStore.setState({ view: { kind: "new", projectId }, settings: false, board: false });
}

/** 在这个会话里打开它自带的一个子 Agent 的视图。 */
export function openSubagent(taskId: string, projectId: ProjectScope, subagent: SubagentRef) {
  openTask(taskId, projectId);
  useNavigationStore.setState({ view: { kind: "task", taskId, projectId, subagent } });
}

/** 从子 Agent 的视图回到它所在的会话。 */
export function closeSubagent() {
  const view = useNavigationStore.getState().view;
  if (view.kind === "task" && view.subagent) {
    useNavigationStore.setState({ view: { kind: "task", taskId: view.taskId, projectId: view.projectId } });
  }
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
  useNavigationStore.setState({ settings: true, board: false });
}

export function closeSettings() {
  useNavigationStore.setState({ settings: false });
}

export function openBoard() {
  useNavigationStore.setState({ board: true, settings: false });
}

export function closeBoard() {
  useNavigationStore.setState({ board: false });
}

/** 主区正摆着这个会话（没被设置页或看板盖住）时是它的 id。 */
export function visibleTaskOf(state: Pick<NavigationState, "view" | "settings" | "board">): string | null {
  if (state.settings || state.board || state.view.kind !== "task") return null;
  return state.view.taskId;
}

export function openProjectDialog(mode: ProjectDialog) {
  useNavigationStore.setState({ projectDialog: mode });
}

export function closeProjectDialog() {
  useNavigationStore.setState({ projectDialog: null });
}
