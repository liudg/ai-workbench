export type SelectionGesture = "down" | "up" | "cancel" | "change";

export type SelectionUpdate = "read" | "clear" | "ignore";

export interface SelectionMenuPoint {
  x: number;
  y: number;
}

/**
 * 框选过程中不读选区。主键松开后才读。
 * 没有按下时选区变了（键盘）也读。点在区域外面则收起，避免松手时又弹出来。
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

/** 松开主键时用指针坐标。键盘改选区时没有松开点，退回选区末端。 */
export function selectionMenuPoint(
  mouseUp: SelectionMenuPoint | null,
  fallback: SelectionMenuPoint | null,
): SelectionMenuPoint | null {
  return mouseUp ?? fallback;
}

/**
 * 菜单左上角对齐松开位置。靠下沿放不下时改到指针上方，靠右沿时往左收。
 */
export function selectionMenuPosition(
  point: SelectionMenuPoint,
  viewport: { width: number; height: number },
  menu: { width: number; height: number },
  margin = 8,
): { top: number; left: number } {
  const viewWidth = Math.max(0, viewport.width);
  const viewHeight = Math.max(0, viewport.height);
  const maxWidth = Math.max(0, viewWidth - margin * 2);
  const maxHeight = Math.max(0, viewHeight - margin * 2);
  const width = Math.min(Math.max(0, menu.width), maxWidth);
  const height = Math.min(Math.max(0, menu.height), maxHeight);
  const maxLeft = Math.max(margin, viewWidth - width - margin);
  const maxTop = Math.max(margin, viewHeight - height - margin);
  const left = Math.min(Math.max(margin, point.x), maxLeft);
  let top = point.y;
  if (top + height > viewHeight - margin) top = point.y - height;
  top = Math.min(Math.max(margin, top), maxTop);
  return { top, left };
}
