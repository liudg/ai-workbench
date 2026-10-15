/**
 * 工具行的展开状态。
 * 回合进行中可以点开。回合一旦结束，这些点开全部收起，之后只保留结束后的点击。
 */

export function toolGroupOpen(openIds: ReadonlySet<string>, id: string): boolean {
  return openIds.has(id);
}

export function toggleToolGroup(openIds: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(openIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** 从进行中变成已结束时丢掉展开。已经结束之后再调用则保持现状。 */
export function activityOpenAfterSettle(
  openIds: ReadonlySet<string>,
  wasSettled: boolean,
  settled: boolean,
): ReadonlySet<string> {
  if (settled && !wasSettled) return new Set();
  return openIds;
}
