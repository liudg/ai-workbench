// 会话视图和 daemon 之间的调用。展示组件不直接碰连接。

import { CLI_TIMEOUT_MS, daemon } from "@/lib/daemon";
import type { SessionOptions } from "@/features/tasks";
import type {
  DiffScope,
  FileSearchResult,
  PathFilter,
  PreviewDocument,
  PreviewImage,
  TreeEntry,
} from "@/lib/ipc";
import type {
  AgentCatalog,
  AgentKind,
  PageAnnotation,
  PermissionMenu,
  PromptAnswer,
  ReviewStart,
  ReviewTargets,
  SubscriptionUsage,
} from "@/types";

/** 文件和差异读哪里：会话的工作目录，或者还没建会话时的项目主目录。 */
export type FileScope = { sessionId: string } | { projectId: string };

export function sendMessage(sessionId: string, text: string, images: string[], now = false) {
  return daemon.call<{ queued: boolean }>("sessions.send", { sessionId, text, images, now }, CLI_TIMEOUT_MS);
}

export function interruptTurn(sessionId: string) {
  return daemon.call<null>("sessions.interrupt", { sessionId }, CLI_TIMEOUT_MS);
}

export function answerPrompt(sessionId: string, promptId: string, answer: PromptAnswer) {
  return daemon.call<null>("sessions.answer", { sessionId, promptId, answer }, CLI_TIMEOUT_MS);
}

export function setSessionOptions(sessionId: string, options: SessionOptions) {
  return daemon.call<null>("sessions.setOptions", { sessionId, options }, CLI_TIMEOUT_MS);
}

export function updateQueued(sessionId: string, id: string, text: string, images: string[]) {
  return daemon.call<null>("sessions.updateQueued", { sessionId, id, text, images }, CLI_TIMEOUT_MS);
}

export function removeQueued(sessionId: string, id: string) {
  return daemon.call<null>("sessions.removeQueued", { sessionId, id }, CLI_TIMEOUT_MS);
}

export function steerQueued(sessionId: string, id: string) {
  return daemon.call<null>("sessions.steerQueued", { sessionId, id }, CLI_TIMEOUT_MS);
}

export function reviewTargets(sessionId: string) {
  return daemon.call<ReviewTargets>("sessions.reviewTargets", { sessionId }, CLI_TIMEOUT_MS);
}

export function startReview(sessionId: string, target: ReviewStart) {
  return daemon.call<null>("sessions.startReview", { sessionId, target }, CLI_TIMEOUT_MS);
}

export function setGoal(sessionId: string, objective: string) {
  return daemon.call<null>("sessions.setGoal", { sessionId, objective }, CLI_TIMEOUT_MS);
}

export function clearGoal(sessionId: string) {
  return daemon.call<null>("sessions.clearGoal", { sessionId }, CLI_TIMEOUT_MS);
}

export function setGoalStatus(sessionId: string, status: "paused" | "active") {
  return daemon.call<null>("sessions.setGoalStatus", { sessionId, status }, CLI_TIMEOUT_MS);
}

export function publishGoal(sessionId: string) {
  return daemon.call<null>("sessions.publishGoal", { sessionId }, CLI_TIMEOUT_MS);
}

export function sessionPermissionMenu(sessionId: string) {
  return daemon.call<PermissionMenu>("sessions.permissionMenu", { sessionId }, CLI_TIMEOUT_MS);
}

export function sessionCatalog(sessionId: string) {
  return daemon.call<AgentCatalog>("sessions.catalog", { sessionId }, CLI_TIMEOUT_MS);
}

export function submitAnnotation(sessionId: string, note: PageAnnotation) {
  return daemon.call<{ queued: boolean }>("sessions.submitAnnotation", { sessionId, note }, CLI_TIMEOUT_MS);
}

export function subscriptionUsage(agent: AgentKind) {
  return daemon.call<SubscriptionUsage>("agents.subscriptionUsage", { agent });
}

export function diffScopes(scope: FileScope) {
  return daemon.call<DiffScope[]>("files.diffScopes", { ...scope });
}

export function diffForScope(scope: FileScope, diffScope: string, ignoreWhitespace: boolean) {
  return daemon.call<string>("files.diff", { ...scope, scope: diffScope, ignoreWhitespace });
}

export function readFile(scope: FileScope, path: string) {
  return daemon.call<PreviewDocument>("files.readFile", { ...scope, path });
}

export function readImage(scope: FileScope, path: string) {
  return daemon.call<PreviewImage>("files.readImage", { ...scope, path });
}

export function listDir(scope: FileScope, path: string) {
  return daemon.call<TreeEntry[]>("files.listDir", { ...scope, path });
}

export function filterPaths(scope: FileScope, query: string) {
  return daemon.call<PathFilter>("files.filterPaths", { ...scope, query });
}

export function searchFiles(scope: FileScope, query: string, mask: string, searchId: number) {
  return daemon.call<FileSearchResult>("files.searchFiles", { ...scope, query, mask, searchId });
}

export function flushQueued(sessionId: string, ids: string[]) {
  return daemon.call<null>("sessions.flushQueued", { sessionId, ids }, CLI_TIMEOUT_MS);
}

export function isGitScope(scope: FileScope) {
  return daemon.call<boolean>("git.isRepo", { ...scope });
}
