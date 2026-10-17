/** 侧栏项目菜单。没有本地路径时不提供「在资源管理器中打开」。 */

export type ProjectMenuAction = "open-folder" | "remove";

export type ProjectMenuEntry =
  | { type: "action"; id: ProjectMenuAction; label: string }
  | { type: "separator" };

export function hasLocalProjectPath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.trim().length > 0;
}

export function projectMenuItems(path: string | null | undefined): ProjectMenuEntry[] {
  const items: ProjectMenuEntry[] = [];
  if (hasLocalProjectPath(path)) {
    items.push({ type: "action", id: "open-folder", label: "在资源管理器中打开" });
    items.push({ type: "separator" });
  }
  items.push({ type: "action", id: "remove", label: "从列表移除" });
  return items;
}
