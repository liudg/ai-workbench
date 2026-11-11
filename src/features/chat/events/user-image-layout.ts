/**
 * 用户消息分两层：图片单独一层，正文留在气泡里。
 * 单张按比例预览；张数变多时缩小并换行，避免把对话列撑开。
 * 尺寸类名写成完整字面量，方便 Tailwind 扫到。
 */

const GAP_PX = 6;

const FRAME = "flex w-fit min-w-0 flex-wrap items-end justify-end gap-1.5";

const BUBBLE =
  "wb-user-bubble min-w-0 max-w-full cursor-text overflow-x-hidden text-[13.5px] leading-6";

export interface UserImageLayout {
  frameClassName: string;
  thumbClassName: string;
  /** 1 是单张预览；2 或 3 是按最大边排下的列数，多出来的换到下一行。 */
  columns: 1 | 2 | 3;
  /** 单张预览的最大宽度，或多张时每格的最大边。 */
  maxEdgePx: number;
  /** 图片层最大宽度。多张时刚好放下 `columns` 格。 */
  frameMaxPx: number;
}

export interface UserBubbleModel {
  images: UserImageLayout | null;
  /** 有正文，或完全没有图片时，才画文字气泡。 */
  showTextBubble: boolean;
  textBubbleClass: string;
}

export function userImageLayout(count: number): UserImageLayout | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (count === 1) {
    return {
      columns: 1,
      maxEdgePx: 320,
      frameMaxPx: 320,
      frameClassName: `${FRAME} max-w-[min(100%,320px)]`,
      thumbClassName: "block h-auto max-h-64 w-auto min-w-0 max-w-full rounded-2xl object-contain",
    };
  }
  if (count === 2) return mosaic(2, 160, "max-h-[160px] max-w-[min(100%,160px)]");
  if (count === 3) return mosaic(3, 112, "max-h-[112px] max-w-[min(100%,112px)]");
  if (count === 4) return mosaic(2, 112, "max-h-[112px] max-w-[min(100%,112px)]");
  return mosaic(3, 80, "max-h-[80px] max-w-[min(100%,80px)]");
}

export function userTextBubbleClass(text: string): string {
  const singleLine = !text.includes("\n") && text.length < 48;
  return singleLine ? `${BUBBLE} rounded-full px-4 py-1.5` : `${BUBBLE} rounded-2xl px-4 py-2.5`;
}

export function userShowsTextBubble(text: string, imageCount: number): boolean {
  if (text.trim().length > 0) return true;
  return imageCount <= 0;
}

export function userBubbleModel(text: string, imageCount: number): UserBubbleModel {
  return {
    images: userImageLayout(imageCount),
    showTextBubble: userShowsTextBubble(text, imageCount),
    textBubbleClass: userTextBubbleClass(text),
  };
}

function mosaic(columns: 2 | 3, maxEdgePx: number, thumbSizeClass: string): UserImageLayout {
  const frameMaxPx = columns * maxEdgePx + (columns - 1) * GAP_PX;
  return {
    columns,
    maxEdgePx,
    frameMaxPx,
    frameClassName: `${FRAME} ${frameMaxClass(frameMaxPx)}`,
    thumbClassName: `block h-auto w-auto min-w-0 rounded-xl object-contain ${thumbSizeClass}`,
  };
}

function frameMaxClass(frameMaxPx: number): string {
  if (frameMaxPx === 326) return "max-w-[min(100%,326px)]";
  if (frameMaxPx === 348) return "max-w-[min(100%,348px)]";
  if (frameMaxPx === 230) return "max-w-[min(100%,230px)]";
  if (frameMaxPx === 252) return "max-w-[min(100%,252px)]";
  return "max-w-full";
}
