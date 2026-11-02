import { MessageCirclePlus } from "lucide-react";

import { registerViewer, type OpenTarget, type PanelViewer } from "@/features/panel/core/registry";
import { tasksApi } from "@/features/tasks";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { dropDraft } from "../session/composer-drafts";
import { SIDE_CHAT_VIEWER, type SideChatPayload } from "./open";
import { SideChatTab } from "./SideChatView";

function taskIdOf(target: OpenTarget): string | null {
  if (target.kind !== "custom" || target.type !== SIDE_CHAT_VIEWER) return null;
  const data = target.data as Partial<SideChatPayload> | undefined;
  return typeof data?.taskId === "string" ? data.taskId : null;
}

/** 打开标签就分叉（开着的直接接上）；关掉标签就关掉侧边聊天，对话和没发的字一起丢掉。 */
const sideChatViewer: PanelViewer<SideChatPayload> = {
  id: SIDE_CHAT_VIEWER,
  match: (target) => (taskIdOf(target) ? 100 : 0),
  icon: MessageCirclePlus,
  title: () => DESKTOP_ZH.sideChat,
  load: async (target) => {
    const taskId = taskIdOf(target) ?? "";
    const side = await tasksApi.openSide(taskId);
    return { taskId, sideId: side.id };
  },
  View: SideChatTab,
  dispose: (payload) => {
    void tasksApi.closeSide(payload.taskId).catch(() => {});
    if (payload.sideId) dropDraft(payload.sideId);
  },
};

let registered = false;

export function registerSideChatViewer() {
  if (registered) return;
  registered = true;
  registerViewer(sideChatViewer);
}
