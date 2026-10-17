/** 置顶区沿用侧栏原有项目顺序。没人置顶时列表为空，侧栏不画「置顶」。 */

export function splitPinnedProjects<T extends { id: string }>(
  projects: readonly T[],
  pinnedIds: readonly string[],
): { pinned: T[]; unpinned: T[] } {
  const pinnedSet = new Set(pinnedIds.filter((id) => id.length > 0));
  const pinned: T[] = [];
  const unpinned: T[] = [];
  for (const project of projects) {
    if (pinnedSet.has(project.id)) pinned.push(project);
    else unpinned.push(project);
  }
  return { pinned, unpinned };
}
