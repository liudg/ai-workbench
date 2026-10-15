import { backend } from "@/lib/ipc";
import { useWorkbench } from "@/store";
import { isMissingSessionError } from "@/store/sync";
import type { Attachment, PermissionMenu, QueuedTurn, ReviewTargets } from "@/types";
import { fileToBase64 } from "./media";

export function reportComposerError(sessionId: string, error: unknown) {
  if (isMissingSessionError(error)) useWorkbench.getState().releaseMissingSession(sessionId);
  else useWorkbench.setState({ lastError: String(error) });
}

export function fetchQueue(sessionId: string): Promise<QueuedTurn[]> {
  return backend.sessionQueue(sessionId);
}

export function storeQueue(sessionId: string, items: QueuedTurn[]) {
  useWorkbench.setState((state) => ({
    queues: { ...state.queues, [sessionId]: items },
  }));
}

export function fetchPermissionMenu(sessionId: string): Promise<PermissionMenu> {
  return backend.permissionMenu(sessionId);
}

export function fetchReviewTargets(sessionId: string): Promise<ReviewTargets> {
  return backend.reviewTargets(sessionId);
}

export async function stageChatImage(file: File): Promise<Attachment> {
  const data = await fileToBase64(file);
  return backend.stageChatImage(data, file.name || "image.png");
}

export function pickAttachments(imagesOn: boolean): Promise<Attachment[]> {
  return imagesOn ? backend.pickImageFiles() : backend.pickFiles();
}

export function pickWritableDirectory(): Promise<string | null> {
  return backend.pickDirectory("添加可写目录");
}

export function updateQueuedTurn(sessionId: string, queuedId: string, text: string, images: string[]) {
  return backend.updateQueuedTurn(sessionId, queuedId, text, images).catch((error: unknown) => {
    reportComposerError(sessionId, error);
  });
}

export function removeQueuedTurn(sessionId: string, queuedId: string) {
  return backend.removeQueuedTurn(sessionId, queuedId).catch((error: unknown) => {
    reportComposerError(sessionId, error);
  });
}

const queuedActions = new Set<string>();

function runQueuedAction(key: string, work: () => Promise<void>) {
  if (queuedActions.has(key)) return Promise.resolve();
  queuedActions.add(key);
  return work().finally(() => {
    queuedActions.delete(key);
  });
}

export function steerQueuedTurn(sessionId: string, queuedId: string) {
  return runQueuedAction(`steer:${sessionId}:${queuedId}`, () =>
    backend.steerQueuedTurn(sessionId, queuedId).catch((error: unknown) => {
      reportComposerError(sessionId, error);
    }),
  );
}

export function closeSessionQueue(sessionId: string) {
  return runQueuedAction(`close:${sessionId}`, () =>
    backend.closeSessionQueue(sessionId).catch((error: unknown) => {
      reportComposerError(sessionId, error);
    }),
  );
}

export function interruptTurn(sessionId: string) {
  return backend.interruptTurn(sessionId).catch((error: unknown) => {
    reportComposerError(sessionId, error);
  });
}

export function searchMentionPaths(projectId: string, query: string) {
  return backend.filterProjectPaths(projectId, query);
}

export function pickMentionFiles() {
  return backend.pickMentionFiles();
}

export function setThreadGoal(sessionId: string, objective: string) {
  return backend.setThreadGoal(sessionId, objective);
}

export function clearThreadGoal(sessionId: string) {
  return backend.clearThreadGoal(sessionId);
}

export function setThreadGoalStatus(sessionId: string, status: "paused" | "active") {
  return backend.setThreadGoalStatus(sessionId, status);
}

export function publishThreadGoal(sessionId: string) {
  return backend.publishThreadGoal(sessionId);
}
