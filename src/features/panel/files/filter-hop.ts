export type FilterHop = "stop" | "retry" | "done";

/**
 * 这次请求被后来的筛选取消时要再要一次，不能把「筛选中」停在 true。
 * 组件已经卸下或查询已经换掉时才停。
 */
export function filterHopAction(input: { stopped: boolean; cancelled: boolean; ready: boolean }): FilterHop {
  if (input.stopped) return "stop";
  if (input.cancelled || !input.ready) return "retry";
  return "done";
}

/** 查询或项目已经换了，就不能再显示上一次的路径。 */
export function matchingFilter<T extends { query: string; projectId: string }>(
  filtered: T | null,
  query: string,
  projectId: string,
): T | null {
  if (!filtered || filtered.query !== query || filtered.projectId !== projectId) return null;
  return filtered;
}
