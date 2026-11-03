import { useEffect } from "react";

import { usePanelStore } from "@/features/panel/state/store";
import { tasksApi } from "@/features/tasks";
import { useConnectionStatus } from "@/lib/daemon";
import { SIDE_CHAT_VIEWER, type SideChatPayload } from "./open";

/** 所有面板里开着侧边聊天标签的任务，排好序拼成一个键，内容不变时不重报。 */
function sideTabKey(state: ReturnType<typeof usePanelStore.getState>): string {
  const ids = new Set<string>();
  for (const panel of Object.values(state.panelBySession)) {
    for (const tab of panel.tabs) {
      if (tab.viewerId !== SIDE_CHAT_VIEWER) continue;
      const taskId = (tab.payload as Partial<SideChatPayload> | undefined)?.taskId;
      if (typeof taskId === "string" && taskId) ids.add(taskId);
    }
  }
  return [...ids].sort().join("\n");
}

/** 侧边聊天标签还开着时，窗口没焦点、切去别的任务也不让 daemon 空闲回收。重连后再报一次。应用里调一次。 */
export function useSideTabsReport() {
  const key = usePanelStore(sideTabKey);
  const status = useConnectionStatus();

  useEffect(() => {
    if (status !== "online") return;
    // 断线时 daemon 已经清掉这条连接的记录，失败不用管。
    void tasksApi.reportSideTabs(key ? key.split("\n") : []).catch(() => undefined);
  }, [key, status]);
}
