/** 打开命令菜单的自定义事件与触发入口。 */
export const OPEN_COMMAND_MENU = "ai-workbench:open-command-menu";

export function openCommandMenu(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_COMMAND_MENU));
}
