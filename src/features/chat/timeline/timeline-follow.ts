export const NEAR_BOTTOM_PX = 80;

export function distanceFromBottom(scrollHeight: number, scrollTop: number, clientHeight: number): number {
  return scrollHeight - scrollTop - clientHeight;
}

export function nearBottom(distance: number, threshold = NEAR_BOTTOM_PX): boolean {
  return distance < threshold;
}

/** 往前补了一页之后，视口仍停在原来那一行。 */
export function historyScrollTop(input: {
  beforeHeight: number;
  beforeTop: number;
  nextHeight: number;
}): number {
  return input.beforeTop + Math.max(0, input.nextHeight - input.beforeHeight);
}

/**
 * 翻页请求回来时，会话已经换过就丢掉这次滚动修正。
 * 否则旧页的高度差会把新会话拽离底部，或把新会话标成没有更早的历史。
 */
export function shouldApplyHistory(input: { epoch: number; currentEpoch: number }): boolean {
  return input.epoch === input.currentEpoch;
}
