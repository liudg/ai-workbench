// 任务的 daemon 调用。展示组件不直接碰连接。

import { CLI_TIMEOUT_MS, daemon } from "@/lib/daemon";
import type { WorktreeDeleteFlags, WorktreeDeletePreview } from "@/lib/worktree-delete";
import type { CreateTaskInput, ImportCandidate, ImportList, ImportResult, TaskEntry } from "./types";

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

/** 项目主目录下 CLI 里开过、还没导入的会话。要读各 Agent 的会话列表，可能要等一会儿。 */
export function importList(projectId: string) {
  return daemon.call<ImportList>("imports.list", { projectId }, CLI_TIMEOUT_MS);
}

export function runImport(projectId: string, items: ImportCandidate[]) {
  return daemon.call<ImportResult>("imports.run", { projectId, items }, CLI_TIMEOUT_MS);
}
