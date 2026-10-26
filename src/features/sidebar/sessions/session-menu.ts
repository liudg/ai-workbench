/** 会话行菜单。改名、置顶、归档、删除都记在工作台的数据库里，所有 Agent 都有。 */

export type SessionMenuAction = "rename" | "pin" | "archive" | "delete";

export interface SessionMenuItem {
  id: SessionMenuAction;
  label: string;
  danger?: boolean;
}

export function sessionMenuItems(input: { pinned: boolean; archived: boolean }): SessionMenuItem[] {
  return [
    { id: "rename", label: "重命名" },
    { id: "pin", label: input.pinned ? "取消置顶" : "置顶" },
    { id: "archive", label: input.archived ? "取消归档" : "归档" },
    { id: "delete", label: "删除", danger: true },
  ];
}
