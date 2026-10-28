/** 侧栏项目菜单。置顶和编辑在前；没有本地路径时不提供「在资源管理器中打开」。 */

export type ProjectMenuAction = "pin" | "edit" | "open-folder" | "remove";

export type ProjectMenuEntry =
  | { type: "action"; id: ProjectMenuAction; label: string }
  | { type: "separator" };

export function hasLocalProjectPath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.trim().length > 0;
}

export function projectMenuItems(input: {
  path: string | null | undefined;
  pinned: boolean;
}): ProjectMenuEntry[] {
  const items: ProjectMenuEntry[] = [
    { type: "action", id: "pin", label: input.pinned ? "取消置顶" : "置顶" },
    { type: "action", id: "edit", label: "编辑" },
    { type: "separator" },
  ];
  if (hasLocalProjectPath(input.path)) {
    items.push({ type: "action", id: "open-folder", label: "在资源管理器中打开" });
    items.push({ type: "separator" });
  }
  items.push({ type: "action", id: "remove", label: "移除项目" });
  return items;
}

/** 移除要再点一次确认。项目下的会话（含已归档）会一起删掉，先说清楚删几个。 */
export function removeConfirmLabel(sessionCount: number): string {
  return sessionCount > 0 ? `删除 ${sessionCount} 个会话并移除？` : "确认移除？";
}
