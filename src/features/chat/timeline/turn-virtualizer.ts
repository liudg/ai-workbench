/** 回合虚拟列表的默认高度。未测量前按这个估算，避免打开时把整页挂上。 */
export const TURN_ESTIMATE_PX = 280;

/** 视口上下各多留的回合数。贴底时下沿会被夹住，实际多出来的是上方这两条。 */
export const TURN_OVERSCAN = 2;

/** 滚动容器还没量到时用的视口高度，只为先算出贴底的窗口。 */
export const TURN_VIEWPORT_FALLBACK = 800;

export interface TurnMeasure {
  key: string;
  height: number;
}

export interface TurnWindow {
  start: number;
  end: number;
  totalHeight: number;
  /** prefix[i] 是第 i 条回合顶边离内容顶部的距离，长度为 count + 1。 */
  prefix: number[];
}

/**
 * 按视口离内容底部的距离选出要挂上的回合。
 * 打开时距离是 0，窗口落在尾部，不会先挂列表头部。
 */
export function turnWindow(input: {
  count: number;
  distanceFromBottom: number;
  viewport: number;
  heights: readonly number[];
  overscan?: number;
}): TurnWindow {
  const count = Math.max(0, Math.trunc(input.count) || 0);
  const heights = normalizeHeights(count, input.heights);
  const prefix = prefixSums(heights);
  const totalHeight = prefix[count] ?? 0;
  const overscan = Math.max(0, input.overscan ?? TURN_OVERSCAN);
  if (count === 0) return { start: 0, end: 0, totalHeight: 0, prefix };
  if (!(input.viewport > 0) || !Number.isFinite(input.viewport)) {
    const start = Math.max(0, count - overscan);
    return { start, end: count, totalHeight, prefix };
  }

  const rawDistance = Number.isFinite(input.distanceFromBottom) ? input.distanceFromBottom : 0;
  const distance = clamp(rawDistance, 0, Math.max(0, totalHeight - input.viewport));
  const viewBottom = totalHeight - distance;
  const viewTop = viewBottom - input.viewport;

  let start = count;
  let end = count;
  for (let index = 0; index < count; index += 1) {
    const top = prefix[index] ?? 0;
    const bottom = prefix[index + 1] ?? top;
    if (bottom > viewTop && top < viewBottom) {
      if (start === count) start = index;
      end = index + 1;
    }
  }
  if (start === count) {
    start = Math.max(0, count - 1);
    end = count;
  }
  return {
    start: clamp(start - overscan, 0, count),
    end: clamp(end + overscan, 0, count),
    totalHeight,
    prefix,
  };
}

export function turnHeights(
  keys: readonly string[],
  measured: ReadonlyMap<string, number>,
  estimate = TURN_ESTIMATE_PX,
): number[] {
  return keys.map((key) => {
    const height = measured.get(key);
    return height != null && height > 0 ? height : estimate;
  });
}

/**
 * 视口上沿以上的高度差。
 * 向前插入和上方测量变高要加进 scrollTop；尾部新消息不算，避免把往上翻的视口拽下去。
 * 调用方在跟随底部时不用这个差值，直接保持距离为 0。
 */
/** 高度变化之后，视口应保持的距底距离。跟随底部时为 0。 */
export function distanceAfterHeightChange(input: {
  beforeDistance: number;
  beforeTotal: number;
  afterTotal: number;
  aboveDelta: number;
  follow: boolean;
}): number {
  if (input.follow) return 0;
  if (!(input.beforeTotal > 0)) return input.beforeDistance;
  return input.beforeDistance + (input.afterTotal - input.beforeTotal - input.aboveDelta);
}

export function aboveViewportDelta(input: {
  before: readonly TurnMeasure[];
  after: readonly TurnMeasure[];
  scrollTop: number;
}): number {
  if (input.before.length === 0) return 0;
  const beforePos = new Map<string, { top: number; height: number }>();
  let top = 0;
  for (const item of input.before) {
    beforePos.set(item.key, { top, height: item.height });
    top += item.height;
  }
  const scrollTop = Number.isFinite(input.scrollTop) ? input.scrollTop : 0;
  let delta = 0;
  for (const item of input.after) {
    const prev = beforePos.get(item.key);
    if (!prev) {
      delta += item.height;
      continue;
    }
    if (prev.top + prev.height <= scrollTop + 0.5) {
      delta += item.height - prev.height;
      continue;
    }
    break;
  }
  return delta;
}

function normalizeHeights(count: number, heights: readonly number[]): number[] {
  const next: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const height = heights[index];
    next.push(height != null && Number.isFinite(height) && height > 0 ? height : TURN_ESTIMATE_PX);
  }
  return next;
}

function prefixSums(heights: readonly number[]): number[] {
  const prefix = new Array<number>(heights.length + 1);
  prefix[0] = 0;
  for (let index = 0; index < heights.length; index += 1) {
    prefix[index + 1] = (prefix[index] ?? 0) + (heights[index] ?? 0);
  }
  return prefix;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
