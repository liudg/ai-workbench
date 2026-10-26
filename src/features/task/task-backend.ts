// 任务视图和 daemon 之间的调用。展示组件不直接碰连接。

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
  AgentProfile,
  PageAnnotation,
  PermissionMenu,
  PromptAnswer,
  ReviewStart,
  ReviewTargets,
  SubscriptionUsage,
} from "@/types";

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

export function diffScopes(sessionId: string) {
  return daemon.call<DiffScope[]>("sessions.diffScopes", { sessionId });
}

export function diffForScope(sessionId: string, scope: string, ignoreWhitespace: boolean) {
  return daemon.call<string>("sessions.diff", { sessionId, scope, ignoreWhitespace });
}

export function readSessionFile(sessionId: string, path: string) {
  return daemon.call<PreviewDocument>("sessions.readFile", { sessionId, path });
}

export function readSessionImage(sessionId: string, path: string) {
  return daemon.call<PreviewImage>("sessions.readImage", { sessionId, path });
}

export function listSessionDir(sessionId: string, path: string) {
  return daemon.call<TreeEntry[]>("sessions.listDir", { sessionId, path });
}

export function filterSessionPaths(sessionId: string, query: string) {
  return daemon.call<PathFilter>("sessions.filterPaths", { sessionId, query });
}

export function searchSessionFiles(sessionId: string, query: string, mask: string, searchId: number) {
  return daemon.call<FileSearchResult>("sessions.searchFiles", { sessionId, query, mask, searchId });
}

export function submitAnnotation(sessionId: string, note: PageAnnotation) {
  return daemon.call<{ queued: boolean }>("sessions.submitAnnotation", { sessionId, note });
}

export function isGitWorkdir(sessionId: string) {
  return daemon.call<boolean>("sessions.isGit", { sessionId });
}

export function reviewTargets(sessionId: string) {
  return daemon.call<ReviewTargets>("sessions.reviewTargets", { sessionId });
}

export function startReview(sessionId: string, target: ReviewStart) {
  return daemon.call<null>("sessions.startReview", { sessionId, target });
}

export function subscriptionUsage(agent: AgentKind) {
  return daemon.call<SubscriptionUsage>("agents.subscriptionUsage", { agent });
}

export function sessionPermissionMenu(sessionId: string) {
  return daemon.call<PermissionMenu>("sessions.permissionMenu", { sessionId });
}

export function draftPermissionMenu(agent: AgentKind) {
  return daemon.call<PermissionMenu>("agents.permissionMenu", { agent });
}

// 模型目录要问 CLI，一种 Agent 这次运行只问一次。线程自己的模型不带过去。
const catalogs = new Map<AgentKind, Promise<AgentCatalog>>();

export function agentCatalog(agent: AgentKind, sessionId: string): Promise<AgentCatalog> {
  let pending = catalogs.get(agent);
  if (!pending) {
    pending = daemon
      .call<AgentCatalog>("sessions.catalog", { sessionId })
      .then((catalog) => ({ ...catalog, thread_model: null }));
    pending.catch(() => catalogs.delete(agent));
    catalogs.set(agent, pending);
  }
  return pending;
}

let profiles: Promise<AgentProfile[]> | null = null;

export function agentProfiles(): Promise<AgentProfile[]> {
  if (!profiles) {
    profiles = daemon.call<AgentProfile[]>("agents.profiles");
    profiles.catch(() => {
      profiles = null;
    });
  }
  return profiles;
}
