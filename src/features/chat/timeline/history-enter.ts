/**
 * 切会话后的第一帧历史不淡入。
 * 尚未就绪时返回空集，调用方把现有回合标成静止。
 * 就绪后，只有排在上一次尾部之后的新回合才淡入；往前翻页插进来的不算。
 */
export function keysEnteringAfterTail(
  keys: readonly string[],
  tail: string | null,
  ready: boolean,
): ReadonlySet<string> {
  if (!ready) return new Set();
  if (tail == null) return new Set(keys);
  const index = keys.lastIndexOf(tail);
  if (index < 0) return new Set();
  return new Set(keys.slice(index + 1));
}

export interface HistoryEnterCursor {
  tail: string | null;
  ready: boolean;
}

/**
 * 空列表不能把追踪标成就绪。
 * 从空列表来的第一包历史把尾部锚到最后一条，这一包不淡入。
 * 已经就绪且锚点为空时同样先锚住，避免整页被标成进入。
 */
export function reduceHistoryEnter(
  cursor: HistoryEnterCursor,
  keys: readonly string[],
): { entering: ReadonlySet<string>; cursor: HistoryEnterCursor } {
  if (keys.length === 0) {
    if (cursor.tail == null) return { entering: new Set(), cursor: { tail: null, ready: false } };
    return { entering: new Set(), cursor };
  }
  const tail = keys[keys.length - 1] ?? null;
  if (!cursor.ready || cursor.tail == null) {
    return { entering: new Set(), cursor: { tail, ready: true } };
  }
  return {
    entering: keysEnteringAfterTail(keys, cursor.tail, true),
    cursor: { tail, ready: true },
  };
}
