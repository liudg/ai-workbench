import type { SessionPanel } from "../../panel/headless.ts";

/** 只选择仍然存在的聊天；最近看的文件或浏览器不改变聊天目标。 */
export function recentSideTab(panel: SessionPanel | undefined) {
  const tabs = panel?.tabs.filter((tab) => {
    if (tab.viewerId !== "side-chat" || tab.status === "error") return false;
    return true;
  }) ?? [];
  const ids = [panel?.activeId, ...(panel?.recentTabIds ?? []), ...tabs.map((tab) => tab.id).reverse()];
  return ids.map((id) => tabs.find((tab) => tab.id === id)).find(Boolean);
}
