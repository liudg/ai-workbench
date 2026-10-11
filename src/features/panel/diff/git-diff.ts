import { backend } from "@/lib/ipc";

/**
 * 差异范围的唯一读取入口。
 * 1A 换成 DiffScopeProvider 时只改这个函数。
 */
export function loadProjectGitDiff(
  projectId: string,
  scope: string,
  ignoreWhitespace: boolean,
): Promise<string> {
  return backend.projectGitDiff(projectId, scope, ignoreWhitespace);
}
