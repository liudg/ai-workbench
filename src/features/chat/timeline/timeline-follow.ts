export const NEAR_BOTTOM_PX = 80;

export function distanceFromBottom(scrollHeight: number, scrollTop: number, clientHeight: number): number {
  return scrollHeight - scrollTop - clientHeight;
}

/** 跟随钩子交给虚拟列表的锚点。距离按滚动容器记，打开时为 0。 */
export interface TimelineAnchor {
  scrollRef: { current: HTMLDivElement | null };
  followRef: { current: boolean };
  distanceRef: { current: number };
  anchorTopRef: { current: number };
  pinningRef: { current: boolean };
  /** 跟随底部时忽略 aboveDelta，把视口补回距离 0。不跟随时只吃掉视口上方的高度差。 */
  applyScroll: (aboveDelta: number) => void;
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
 * 布局变高之后的 scrollTop。
 * 跟随底部时距离保持 0，打开长会话只会落到估算高度的底部，而不是从顶一路钉下来。
 * 不跟随且上方没有增高时返回 null，调用方不要改 scrollTop，尾部新内容不会把视口拽下去。
 */
export function compensatedScrollTop(input: {
  beforeTop: number;
  nextHeight: number;
  clientHeight: number;
  follow: boolean;
  aboveDelta: number;
}): number | null {
  if (!Number.isFinite(input.nextHeight) || !Number.isFinite(input.clientHeight)) return null;
  if (input.follow) return Math.max(0, input.nextHeight - input.clientHeight);
  if (!Number.isFinite(input.aboveDelta) || input.aboveDelta === 0) return null;
  const base = Number.isFinite(input.beforeTop) ? input.beforeTop : 0;
  return Math.max(0, base + input.aboveDelta);
}

/**
 * 翻页请求回来时，会话已经换过就丢掉这次滚动修正。
 * 否则旧页的高度差会把新会话拽离底部，或把新会话标成没有更早的历史。
 */
export function shouldApplyHistory(input: { epoch: number; currentEpoch: number }): boolean {
  return input.epoch === input.currentEpoch;
}
