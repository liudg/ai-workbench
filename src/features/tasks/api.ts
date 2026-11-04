// 任务的 daemon 调用。展示组件不直接碰连接。

import { CLI_TIMEOUT_MS, daemon } from "@/lib/daemon";
import type { WorktreeDeleteFlags, WorktreeDeletePreview } from "@/lib/worktree-delete";
import type { AgentKind } from "@/types";
import type {
  CreateTaskInput,
  ImportCandidate,
  ImportPage,
  ImportResult,
  SessionOptions,
  TaskEntry,
  TaskSession,
} from "./types";

export function createTask(input: CreateTaskInput) {
  const { projectId, ...rest } = input;
  return daemon.call<TaskEntry>("tasks.create", projectId ? { projectId, ...rest } : rest);
}

export function renameTask(id: string, title: string) {
  return daemon.call<boolean>("tasks.rename", { id, title });
}

export function setTaskPinned(id: string, pinned: boolean) {
  return daemon.call<boolean>("tasks.setPinned", { id, pinned });
}

export function archiveTask(id: string, archived: boolean) {
  return daemon.call<boolean>("tasks.archive", { id, archived });
}

export function deletePreview(id: string) {
  return daemon.call<WorktreeDeletePreview>("tasks.deletePreview", { id });
}

export function removeTask(id: string, options: WorktreeDeleteFlags) {
  return daemon.call<boolean>("tasks.remove", { id, ...options });
}

/** 开子任务卡片上的选择：另开，或者不另开。 */
export function resolveOffer(sessionId: string, offerId: string, accept: boolean) {
  return daemon.call<null>("tasks.resolveOffer", { sessionId, offerId, accept }, CLI_TIMEOUT_MS);
}

/** 任务换一个 Agent 接着做。前文在新 Agent 的第一条消息里交过去。 */
export function switchAgent(taskId: string, agent: AgentKind, options: SessionOptions) {
  return daemon.call<TaskEntry>("tasks.switchAgent", { taskId, agent, options }, CLI_TIMEOUT_MS);
}

/** 从任务现在的样子分出一个新任务。不给 Agent 时用原来的。 */
export function forkTask(taskId: string, agent?: AgentKind) {
  return daemon.call<TaskEntry>("tasks.fork", agent ? { taskId, agent } : { taskId }, CLI_TIMEOUT_MS);
}

/** 能导入会话的 Agent。 */
export function importSources() {
  return daemon.call<AgentKind[]>("imports.sources");
}

/** 项目主目录下某个 Agent 在 CLI 里开过、还没导入的会话，一次一页。 */
export function importList(projectId: string, agent: AgentKind, cursor: string | null) {
  return daemon.call<ImportPage>("imports.list", { projectId, agent, cursor }, CLI_TIMEOUT_MS);
}

export function runImport(projectId: string, items: ImportCandidate[]) {
  return daemon.call<ImportResult>("imports.run", { projectId, items }, CLI_TIMEOUT_MS);
}

/** 开着的侧边聊天，没开就从任务现在这段分出一个。 */
export function openSide(taskId: string) {
  return daemon.call<TaskSession>("tasks.openSide", { taskId }, CLI_TIMEOUT_MS);
}

/** 关掉侧边聊天，它的对话一起丢掉。 */
export function closeSide(taskId: string) {
  return daemon.call<boolean>("tasks.closeSide", { taskId }, CLI_TIMEOUT_MS);
}

/** 告诉 daemon 面板里哪些任务开着侧边聊天标签。有标签的不会因为空闲被关掉。 */
export function reportSideTabs(taskIds: string[]) {
  return daemon.call<null>("tasks.sideTabs", { taskIds });
}
