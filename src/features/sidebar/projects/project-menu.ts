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
