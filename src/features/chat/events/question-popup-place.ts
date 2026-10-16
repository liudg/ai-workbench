const VIEW_MARGIN = 8;

export interface QuestionPopupAnchor {
  left: number;
  top: number;
  width: number;
}

export interface QuestionPopupPlace {
  left: number;
  width: number;
  /** 距视口底边，使卡片底边停在锚点上沿之上。 */
  bottom: number;
  maxHeight: number;
}

/**
 * 浮层对齐作曲栏，并停在它上方。
 * `ceiling` 是不能盖住的下沿（聊天顶栏底部），用来限制高度。
 */
export function placeQuestionPopup(
  anchor: QuestionPopupAnchor,
  viewport: { width: number; height: number },
  ceiling = VIEW_MARGIN,
  gap = 8,
): QuestionPopupPlace {
  let left = anchor.left;
  let width = anchor.width;
  const maxRight = Math.max(VIEW_MARGIN, viewport.width - VIEW_MARGIN);
  if (left < VIEW_MARGIN) {
    width -= VIEW_MARGIN - left;
    left = VIEW_MARGIN;
  }
  if (left + width > maxRight) width = maxRight - left;
  width = Math.max(0, width);
  const bottom = viewport.height - anchor.top + gap;
  const maxHeight = Math.max(96, anchor.top - gap - ceiling);
  return { left, width, bottom, maxHeight };
}

/** 卡片真正挂上之后才聚焦。位置还没算出来时不聚焦，否则按键落不到卡片上。 */
export function questionFocusRequest(input: {
  placed: boolean;
  closed: boolean;
  hasQuestion: boolean;
  freeform: boolean;
}): "freeform" | "card" | null {
  if (!input.placed || input.closed || !input.hasQuestion) return null;
  return input.freeform ? "freeform" : "card";
}
