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
