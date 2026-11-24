// 任务的 daemon 调用。展示组件不直接碰连接。

import { CLI_TIMEOUT_MS, daemon } from "@/lib/daemon";
import type { WorktreeDeleteFlags, WorktreeDeletePreview } from "@/lib/worktree-delete";
import type { AgentKind, GeneratedCommitMessage } from "@/types";
import type {
  CreateTaskInput,
  ImportCandidate,
  ImportPage,
  ImportResult,
  RewindPreview,
  RewindResult,
  SearchTasksQuery,
  SessionOptions,
  TaskEntry,
  TaskSearchHit,
  TaskSession,
} from "./types";

export function createTask(input: CreateTaskInput) {
  const { projectId, ...rest } = input;
  return daemon.call<TaskEntry>("tasks.create", projectId ? { projectId, ...rest } : rest);
}

export function renameTask(id: string, title: string) {
  return daemon.call<boolean>("tasks.rename", { id, title });
}

export function taskWorkdir(id: string) {
  return daemon.call<string>("tasks.workdir", { id });
}

export function exportMarkdown(id: string) {
  return daemon.call<string>("tasks.exportMarkdown", { id });
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

/** 把清理掉的工作树放回原路径。 */
export function restoreWorktree(id: string) {
  return daemon.call<null>("tasks.restoreWorktree", { id }, CLI_TIMEOUT_MS);
}

/** 工作树任务交给项目目录，或交回工作树。工作树没有分支时要给分支名。 */
export function handOff(id: string, to: "local" | "worktree", branch?: string) {
  return daemon.call<TaskEntry>("tasks.handOff", branch ? { id, to, branch } : { id, to }, CLI_TIMEOUT_MS);
}

/** 开子任务卡片上的选择：另开，或者不另开。 */
export function resolveOffer(sessionId: string, offerId: string, accept: boolean) {
  return daemon.call<null>("tasks.resolveOffer", { sessionId, offerId, accept }, CLI_TIMEOUT_MS);
}

/** 任务换一个 Agent / 实例接着做。前文在新 Agent 的第一条消息里交过去。 */
export function switchAgent(
  taskId: string,
  agent: AgentKind,
  options: SessionOptions,
  instanceId?: string,
) {
  return daemon.call<TaskEntry>(
    "tasks.switchAgent",
    instanceId ? { taskId, agent, instanceId, options } : { taskId, agent, options },
    CLI_TIMEOUT_MS,
  );
}

/** 从任务现在的样子分出一个新任务。不给 Agent 时用原来的。 */
export function forkTask(taskId: string, agent?: AgentKind, instanceId?: string) {
  const params: Record<string, unknown> = { taskId };
  if (agent) params.agent = agent;
  if (instanceId !== undefined) params.instanceId = instanceId;
  return daemon.call<TaskEntry>("tasks.fork", params, CLI_TIMEOUT_MS);
}

/** 跨项目会话标题与正文全文检索（SQLite FTS5 trigram）。 */
export function searchTasks(params: SearchTasksQuery) {
  return daemon.call<TaskSearchHit[]>("tasks.search", { ...params });
}

/** 用轻量模型为指定任务重新生成会话标题。 */
export function regenerateTitle(taskId: string) {
  return daemon.call<{ title: string }>("tasks.regenerateTitle", { taskId }, CLI_TIMEOUT_MS);
}

/** 用轻量模型生成符合 Git 规范的语义化短分支名。 */
export function generateBranchName(params: {
  prompt?: string;
  taskId?: string;
  projectId?: string | null;
}) {
  const payload: Record<string, unknown> = { prompt: params.prompt ?? "" };
  if (params.taskId) payload.taskId = params.taskId;
  if (params.projectId) payload.projectId = params.projectId;
  return daemon.call<{ branch: string }>("textGen.branchName", payload, CLI_TIMEOUT_MS);
}

/** 用轻量模型根据当前 Diff 与最近提交风格生成结构化 Commit 说明。 */
export function generateCommitMessage(params: {
  sessionId?: string | null;
  projectId?: string | null;
  diffScope?: string;
}) {
  const payload: Record<string, unknown> = {};
  if (params.sessionId) payload.sessionId = params.sessionId;
  if (params.projectId) payload.projectId = params.projectId;
  if (params.diffScope) payload.diffScope = params.diffScope;
  return daemon.call<GeneratedCommitMessage>("textGen.commitMessage", payload, CLI_TIMEOUT_MS);
}

/** 回退某条用户消息前的安全预检（是否允许还原文件、是否有未归属手工改动提醒）。 */
export function rewindPreview(sessionId: string, userEventId: string) {
  return daemon.call<RewindPreview>("sessions.rewindPreview", { sessionId, userEventId });
}

/** 执行对话回退（可选协同还原工作区文件）。 */
export function rewindSession(sessionId: string, userEventId: string, restoreFiles: boolean) {
  return daemon.call<RewindResult>(
    "sessions.rewind",
    { sessionId, userEventId, restoreFiles },
    CLI_TIMEOUT_MS,
  );
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

/** 从当前对话新建一个独立的侧边聊天。 */
export function openSide(taskId: string) {
  return daemon.call<TaskSession>("tasks.openSide", { taskId }, CLI_TIMEOUT_MS);
}

/** 关掉侧边聊天，它的对话一起丢掉。 */
export function closeSide(sessionId: string) {
  return daemon.call<boolean>("tasks.closeSide", { sessionId }, CLI_TIMEOUT_MS);
}

/** 上报有标签的侧边会话，按会话保护它们不被空闲回收。 */
export function reportSideTabs(sessionIds: string[]) {
  return daemon.call<null>("tasks.sideTabs", { sessionIds });
}
