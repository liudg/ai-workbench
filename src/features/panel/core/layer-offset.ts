/** 浮层贴着锚点。end 右对齐，start 左对齐。靠近窗口边缘时收回来。 */

export function layerOffset(input: {
  anchorLeft: number;
  anchorRight: number;
  anchorTop: number;
  anchorBottom: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  align: "start" | "end";
}): { left: number; top: number } {
  const preferred = input.align === "end" ? input.anchorRight - input.width : input.anchorLeft;
  const left = Math.min(Math.max(8, preferred), input.viewportWidth - input.width - 8);
  let top = input.anchorBottom + 6;
  if (top + input.height > input.viewportHeight - 8) top = Math.max(8, input.anchorTop - input.height - 6);
  return { left, top };
}
