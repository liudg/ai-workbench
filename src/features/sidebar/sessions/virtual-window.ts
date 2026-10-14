export interface VirtualRange {
  start: number;
  end: number;
}

/** 行槽高度：h-7 的 28px，加上原先列表 2px 的行距。 */
export const SESSION_ROW_HEIGHT = 30;

export const SESSION_ROW_OVERSCAN = 8;

export function visibleRange(input: {
  count: number;
  scrollTop: number;
  viewport: number;
  itemHeight: number;
  overscan?: number;
}): VirtualRange {
  const { count, scrollTop, viewport, itemHeight } = input;
  const overscan = Math.max(0, input.overscan ?? 0);
  if (
    count <= 0 ||
    itemHeight <= 0 ||
    viewport <= 0 ||
    !Number.isFinite(count) ||
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(viewport) ||
    !Number.isFinite(itemHeight)
  ) {
    return { start: 0, end: 0 };
  }
  const first = Math.floor(scrollTop / itemHeight);
  const last = Math.ceil((scrollTop + viewport) / itemHeight);
  const start = clamp(first - overscan, 0, count);
  const end = clamp(Math.max(start, last + overscan), 0, count);
  return { start, end };
}

/** 滚动窗口还没量到时，丢掉越界的旧区间。空区间表示当前视口里没有行。 */
export function clampRange(range: VirtualRange, count: number, head = 24): VirtualRange {
  if (count <= 0) return { start: 0, end: 0 };
  const start = Math.trunc(range.start);
  const end = Math.trunc(range.end);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start > count ||
    end > count
  ) {
    return { start: 0, end: Math.min(count, head) };
  }
  return { start, end };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
