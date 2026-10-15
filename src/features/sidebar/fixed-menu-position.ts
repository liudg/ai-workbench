export interface MenuRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

/** 菜单贴着触发器，并且整块落在视口里，避免把页面撑出横向滚动。 */
export function fixedMenuPosition(input: {
  anchor: MenuRect;
  menu: MenuSize;
  viewport: { width: number; height: number };
  prefer: "below" | "above";
  margin?: number;
  gap?: number;
}): { top: number; left: number; maxWidth: number; maxHeight: number } {
  const margin = input.margin ?? 8;
  const gap = input.gap ?? 6;
  const viewWidth = Math.max(0, input.viewport.width);
  const viewHeight = Math.max(0, input.viewport.height);
  const maxWidth = Math.max(0, viewWidth - margin * 2);
  const maxHeight = Math.max(0, viewHeight - margin * 2);
  const width = Math.min(Math.max(0, input.menu.width), maxWidth);
  const height = Math.min(Math.max(0, input.menu.height), maxHeight);
  let left = input.prefer === "below" ? input.anchor.right - width : input.anchor.left;
  const maxLeft = Math.max(margin, viewWidth - width - margin);
  left = Math.min(Math.max(margin, left), maxLeft);
  const below = input.anchor.bottom + gap;
  const above = input.anchor.top - height - gap;
  let top = input.prefer === "above" ? above : below;
  if (top + height > viewHeight - margin) top = above;
  if (top < margin) top = below;
  const maxTop = Math.max(margin, viewHeight - height - margin);
  top = Math.min(Math.max(margin, top), maxTop);
  return { top, left, maxWidth, maxHeight };
}
