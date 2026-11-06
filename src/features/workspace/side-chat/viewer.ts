import { MessageCirclePlus } from "lucide-react";

import { registerViewer, type OpenTarget, type PanelViewer } from "@/features/panel/core/registry";
import { SIDE_CHAT_VIEWER, loadSideChat, disposeSideChat, type SideChatPayload } from "./open";
import { SideChatTab } from "./SideChatView";

function taskIdOf(target: OpenTarget): string | null {
  if (target.kind !== "custom" || target.type !== SIDE_CHAT_VIEWER) return null;
  const data = target.data as Partial<SideChatPayload> | undefined;
  return typeof data?.taskId === "string" ? data.taskId : null;
}

/** 每个标签分出独立会话；关闭只清理这个标签对应的聊天和草稿。 */
const sideChatViewer: PanelViewer<SideChatPayload> = {
  id: SIDE_CHAT_VIEWER,
  match: (target) => (taskIdOf(target) ? 100 : 0),
  icon: MessageCirclePlus,
  title: (payload) => payload.title,
  load: async (target) => {
    return loadSideChat((target as Extract<OpenTarget, { kind: "custom" }>).data as SideChatPayload);
  },
  View: SideChatTab,
  dispose: disposeSideChat,
};

let registered = false;

export function registerSideChatViewer() {
  if (registered) return;
  registered = true;
  registerViewer(sideChatViewer);
}
