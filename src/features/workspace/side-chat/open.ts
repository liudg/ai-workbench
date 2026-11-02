// 侧边聊天在右侧面板里是一个标签。打开它、把排队消息挪过去问，都从这里走。

import type { OpenTarget } from "@/features/panel/core/registry";
import { usePanelStore } from "@/features/panel/state/store";
import { tasksApi, type TaskEntry } from "@/features/tasks";
import { showError } from "@/shared/shell/error-banner";
import type { AgentProfile, QueuedTurn } from "@/types";
import { removeQueued, sendMessage } from "../session/api";

export const SIDE_CHAT_VIEWER = "side-chat";

export interface SideChatPayload {
  taskId: string;
  /** 分出来的侧边聊天会话。加载完才有，关标签时用它清掉没发的草稿。 */
  sideId?: string;
  error?: string;
}

export function sideChatTarget(taskId: string): OpenTarget {
  return { kind: "custom", type: SIDE_CHAT_VIEWER, data: { taskId } satisfies SideChatPayload };
}

/** Agent 能分出侧边聊天，主对话也已经有原生会话可分。 */
export function canOpenSideChat(task: TaskEntry, profile: AgentProfile | undefined): boolean {
  const current = task.sessions[task.sessions.length - 1];
  return Boolean(profile?.capabilities.supports_side_chat && current?.nativeId);
}

const NO_CONTEXT = { projectId: "", projectPath: "", sessionFiles: [] };

export function openSideChatTab(mainSessionId: string, taskId: string) {
  void usePanelStore.getState().panelOpenTarget(mainSessionId, sideChatTarget(taskId), NO_CONTEXT);
}

/**
 * 排队消息挪到侧边聊天里发出去。先从主对话的队列拿掉，免得主回合恰好结束时两边都发；
 * 侧边聊天没发出去就排回主对话（Codex `restore_side_user_message`）。
 */
export function askInSideChat(mainSessionId: string, taskId: string, item: QueuedTurn) {
  const images = item.images ?? [];
  openSideChatTab(mainSessionId, taskId);
  void removeQueued(mainSessionId, item.id)
    .then(() =>
      tasksApi
        .openSide(taskId)
        .then((side) => sendMessage(side.id, item.text, images))
        .catch((error: unknown) => {
          showError(error);
          return sendMessage(mainSessionId, item.text, images);
        }),
    )
    .catch(showError);
}

/** 界面重载后面板标签没了，daemon 里的侧边聊天还开着：没有标签就关掉它。 */
export function closeOrphanSideChat(mainSessionId: string, task: TaskEntry) {
  if (!task.side) return;
  const tabs = usePanelStore.getState().panelBySession[mainSessionId]?.tabs ?? [];
  if (tabs.some((tab) => tab.viewerId === SIDE_CHAT_VIEWER)) return;
  void tasksApi.closeSide(task.id).catch(() => {});
}
