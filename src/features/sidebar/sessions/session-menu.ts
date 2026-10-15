/** 会话行菜单。只看当前会话适配器的能力，不比较 Agent 种类。置顶是工作台本地状态。 */

export type SessionMenuAction = "rename" | "pin" | "archive" | "delete";

export interface SessionMenuCaps {
  supports_rename?: boolean;
  supports_archive?: boolean;
  supports_delete?: boolean;
}

export interface SessionMenuItem {
  id: SessionMenuAction;
  label: string;
  danger?: boolean;
}

export function sessionMenuItems(input: {
  caps: SessionMenuCaps | null | undefined;
  pinned: boolean;
  archived: boolean;
}): SessionMenuItem[] {
  const items: SessionMenuItem[] = [];
  if (input.caps?.supports_rename) {
    items.push({ id: "rename", label: "重命名" });
  }
  items.push({ id: "pin", label: input.pinned ? "取消置顶" : "置顶" });
  if (input.caps?.supports_archive) {
    items.push({
      id: "archive",
      label: input.archived ? "取消归档" : "归档",
    });
  }
  if (input.caps?.supports_delete) {
    items.push({ id: "delete", label: "删除", danger: true });
  }
  return items;
}
