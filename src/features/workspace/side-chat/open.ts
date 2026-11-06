import type { OpenTarget } from "@/features/panel/core/registry";
import { usePanelStore } from "@/features/panel/state/store";
import { tasksApi, type TaskEntry, type TaskSession } from "@/features/tasks";
import { showError } from "@/shared/shell/error-banner";
import type { TextSnippetDraft } from "@/shared/text-snippet";
import type { QueuedTurn } from "@/types";
import { removeQueued } from "../session/api";
import { addDraftSnippet, appendQueuedDraft, dropDraft } from "../session/composer-drafts";
import { recentSideTab } from "./selection";

export const SIDE_CHAT_VIEWER = "side-chat";
export interface SideChatPayload {
  taskId: string;
  key: string;
  title: string;
  sideId?: string;
  error?: string;
}
const opening = new Map<string, { promise: Promise<TaskSession>; closed: boolean }>();
const NO_CONTEXT = { projectId: "", projectPath: "", sessionFiles: [] };

export function sideChatTarget(taskId: string): OpenTarget {
  const tabs = Object.values(usePanelStore.getState().panelBySession).flatMap((panel) => panel.tabs);
  const numbers = tabs.filter((tab) => tab.viewerId === SIDE_CHAT_VIEWER && (tab.payload as SideChatPayload).taskId === taskId)
    .map((tab) => Number((tab.payload as SideChatPayload).title?.split(" ").slice(-1)[0]) || 0);
  const key = crypto.randomUUID();
  return { kind: "custom", type: SIDE_CHAT_VIEWER, key, data: { taskId, key, title: `侧边聊天 ${Math.max(0, ...numbers) + 1}` } satisfies SideChatPayload };
}

export async function loadSideChat(payload: SideChatPayload): Promise<SideChatPayload> {
  const entry = { promise: tasksApi.openSide(payload.taskId), closed: false };
  opening.set(payload.key, entry);
  try {
    const side = await entry.promise;
    if (entry.closed) await tasksApi.closeSide(side.id);
    return { ...payload, sideId: side.id };
  } finally {
    opening.delete(payload.key);
  }
}

export function disposeSideChat(payload: SideChatPayload) {
  const entry = opening.get(payload.key);
  if (entry) entry.closed = true;
  if (payload.sideId) {
    dropDraft(payload.sideId);
    void tasksApi.closeSide(payload.sideId).catch(showError);
  }
}

async function recentSideChat(mainSessionId: string, taskId: string): Promise<string> {
  const state = usePanelStore.getState();
  const panel = state.panelBySession[mainSessionId];
  let tab = recentSideTab(panel);
  let sideId: string | undefined;
  if (!tab) {
    const target = sideChatTarget(taskId);
    await state.panelOpenTarget(mainSessionId, target, NO_CONTEXT);
    tab = usePanelStore.getState().panelBySession[mainSessionId]?.tabs.find((item) => (item.payload as SideChatPayload)?.key === (target.kind === "custom" ? target.key : ""));
  } else {
    state.panelSelectTab(mainSessionId, tab.id);
    state.panelShow(mainSessionId);
    const payload = tab.payload as SideChatPayload;
    sideId = (await opening.get(payload.key)?.promise)?.id;
    tab = usePanelStore.getState().panelBySession[mainSessionId]?.tabs.find((item) => item.id === tab?.id);
  }
  const payload = tab?.payload as SideChatPayload | undefined;
  sideId = payload?.sideId ?? sideId;
  if (!tab || !sideId || tab.status === "error") throw new Error(payload?.error ?? "侧边聊天已关闭");
  return sideId;
}

export function askInSideChat(mainSessionId: string, taskId: string, item: QueuedTurn) {
  return recentSideChat(mainSessionId, taskId).then(async (sideId) => {
    await appendQueuedDraft(sideId, item, () => removeQueued(mainSessionId, item.id));
  }).catch(showError);
}

export function startSideChatWith(mainSessionId: string, taskId: string, draft: TextSnippetDraft) {
  return recentSideChat(mainSessionId, taskId).then((sideId) => addDraftSnippet(sideId, draft)).catch(showError);
}

export function closeOrphanSideChat(mainSessionId: string, task: TaskEntry) {
  const tabs = usePanelStore.getState().panelBySession[mainSessionId]?.tabs ?? [];
  if (tabs.some((tab) => tab.viewerId === SIDE_CHAT_VIEWER && tab.status === "loading")) return;
  for (const side of task.sides ?? []) {
    if (!tabs.some((tab) => tab.viewerId === SIDE_CHAT_VIEWER && (tab.payload as SideChatPayload).sideId === side.id)) {
      void tasksApi.closeSide(side.id).catch(showError);
    }
  }
}
