/** 默认列表只留未归档。已归档的会话不进侧栏。 */

export function partitionSidebarSessions<T extends { archived?: boolean }>(
  sessions: readonly T[],
): { active: T[]; archived: T[] } {
  const active: T[] = [];
  const archived: T[] = [];
  for (const session of sessions) {
    if (session.archived) archived.push(session);
    else active.push(session);
  }
  return { active, archived };
}
