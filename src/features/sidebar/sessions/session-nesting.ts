// 子任务不管隔了几层，都平铺在顶层任务下面。上面的任务不在这一组里（归档了、删了）时，从断开的地方自己算一行。

export interface Nestable {
  id: string;
  parentTaskId: string | null;
}

export interface SessionLine<T> {
  task: T;
  /** 1 是子任务。 */
  depth: 0 | 1;
  /** 是这个顶层任务下最后一个子任务。 */
  last: boolean;
  /** 顶层任务下的后代数。 */
  subtasks: number;
  collapsed: boolean;
}

/** 顶层的行，和每个顶层任务下的所有后代（保持原来的顺序）。 */
export function splitSubtasks<T extends Nestable>(tasks: readonly T[]): { roots: T[]; childrenOf: Map<string, T[]> } {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rootOf = (task: T): T => {
    let top = task;
    for (;;) {
      const parent = top.parentTaskId ? byId.get(top.parentTaskId) : undefined;
      if (!parent) return top;
      top = parent;
    }
  };
  const roots: T[] = [];
  const childrenOf = new Map<string, T[]>();
  for (const task of tasks) {
    const root = rootOf(task);
    if (root === task) {
      roots.push(task);
      continue;
    }
    const list = childrenOf.get(root.id);
    if (list) list.push(task);
    else childrenOf.set(root.id, [task]);
  }
  return { roots, childrenOf };
}

/** 顶层行展开成一列：没折叠的顶层任务后面跟着它的后代。 */
export function nestLines<T extends Nestable>(
  roots: readonly T[],
  childrenOf: ReadonlyMap<string, readonly T[]>,
  collapsed: ReadonlySet<string>,
): SessionLine<T>[] {
  const lines: SessionLine<T>[] = [];
  for (const task of roots) {
    const children = childrenOf.get(task.id) ?? [];
    const folded = collapsed.has(task.id);
    lines.push({ task, depth: 0, last: false, subtasks: children.length, collapsed: folded });
    if (folded) continue;
    children.forEach((child, index) => {
      lines.push({ task: child, depth: 1, last: index === children.length - 1, subtasks: 0, collapsed: false });
    });
  }
  return lines;
}
