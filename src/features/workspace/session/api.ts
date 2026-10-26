// 会话视图和 daemon 之间的调用。展示组件不直接碰连接。

import { daemon } from "@/lib/daemon";
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
  return daemon.call<{ queued: boolean }>("sessions.send", { sessionId, text, images, now });
}

export function interruptTurn(sessionId: string) {
  return daemon.call<null>("sessions.interrupt", { sessionId });
}

export function answerPrompt(sessionId: string, promptId: string, answer: PromptAnswer) {
  return daemon.call<null>("sessions.answer", { sessionId, promptId, answer });
}

export function setSessionOptions(sessionId: string, options: SessionOptions) {
  return daemon.call<null>("sessions.setOptions", { sessionId, options });
}

export function updateQueued(sessionId: string, id: string, text: string, images: string[]) {
  return daemon.call<null>("sessions.updateQueued", { sessionId, id, text, images });
}

export function removeQueued(sessionId: string, id: string) {
  return daemon.call<null>("sessions.removeQueued", { sessionId, id });
}

export function steerQueued(sessionId: string, id: string) {
  return daemon.call<null>("sessions.steerQueued", { sessionId, id });
}

export function reviewTargets(sessionId: string) {
  return daemon.call<ReviewTargets>("sessions.reviewTargets", { sessionId });
}

export function startReview(sessionId: string, target: ReviewStart) {
  return daemon.call<null>("sessions.startReview", { sessionId, target });
}

export function setGoal(sessionId: string, objective: string) {
  return daemon.call<null>("sessions.setGoal", { sessionId, objective });
}

export function clearGoal(sessionId: string) {
  return daemon.call<null>("sessions.clearGoal", { sessionId });
}

export function setGoalStatus(sessionId: string, status: "paused" | "active") {
  return daemon.call<null>("sessions.setGoalStatus", { sessionId, status });
}

export function publishGoal(sessionId: string) {
  return daemon.call<null>("sessions.publishGoal", { sessionId });
}

export function sessionPermissionMenu(sessionId: string) {
  return daemon.call<PermissionMenu>("sessions.permissionMenu", { sessionId });
}

export function sessionCatalog(sessionId: string) {
  return daemon.call<AgentCatalog>("sessions.catalog", { sessionId });
}

export function submitAnnotation(sessionId: string, note: PageAnnotation) {
  return daemon.call<{ queued: boolean }>("sessions.submitAnnotation", { sessionId, note });
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
  return daemon.call<null>("sessions.flushQueued", { sessionId, ids });
}

export function isGitScope(scope: FileScope) {
  return daemon.call<boolean>("git.isRepo", { ...scope });
}
