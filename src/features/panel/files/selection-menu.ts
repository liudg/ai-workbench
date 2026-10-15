export type SelectionGesture = "down" | "up" | "cancel" | "change";

export type SelectionUpdate = "read" | "clear" | "ignore";

/**
 * 框选过程中不读选区。主键松开后才读。
 * 没有按下时选区变了（键盘）也读。点在预览外面则收起，避免松手时又弹出来。
 */
export function selectionMenuUpdate(
  event: SelectionGesture,
  dragging: boolean,
  inside = true,
): { dragging: boolean; update: SelectionUpdate } {
  if (event === "down") {
    if (!inside) return { dragging: false, update: "clear" };
    return { dragging: true, update: "clear" };
  }
  if (event === "cancel") return { dragging: false, update: "clear" };
  if (event === "up") {
    if (!dragging) return { dragging: false, update: "ignore" };
    return { dragging: false, update: "read" };
  }
  if (dragging) return { dragging: true, update: "clear" };
  return { dragging: false, update: "read" };
}
