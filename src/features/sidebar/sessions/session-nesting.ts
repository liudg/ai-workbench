// 子任务挂在开出它的任务下面。父任务不在这一组里（归档了、删了）时，子任务自己算一行。

export interface Nestable {
  id: string;
  parentTaskId: string | null;
}

export interface SessionLine<T> {
  task: T;
  /** 1 是子任务。 */
  depth: 0 | 1;
  /** 父任务下的子任务数。 */
  subtasks: number;
  collapsed: boolean;
}

/** 顶层的行，和每个父任务下的子任务（保持原来的顺序）。 */
export function splitSubtasks<T extends Nestable>(tasks: readonly T[]): { roots: T[]; childrenOf: Map<string, T[]> } {
  const ids = new Set(tasks.map((task) => task.id));
  const roots: T[] = [];
  const childrenOf = new Map<string, T[]>();
  for (const task of tasks) {
    const parent = task.parentTaskId;
    if (parent && ids.has(parent)) {
      const list = childrenOf.get(parent);
      if (list) list.push(task);
      else childrenOf.set(parent, [task]);
    } else {
      roots.push(task);
    }
  }
  return { roots, childrenOf };
}

/** 顶层行展开成一列：没折叠的父任务后面跟着它的子任务。 */
export function nestLines<T extends Nestable>(
  roots: readonly T[],
  childrenOf: ReadonlyMap<string, readonly T[]>,
  collapsed: ReadonlySet<string>,
): SessionLine<T>[] {
  const lines: SessionLine<T>[] = [];
  for (const task of roots) {
    const children = childrenOf.get(task.id) ?? [];
    const folded = collapsed.has(task.id);
    lines.push({ task, depth: 0, subtasks: children.length, collapsed: folded });
    if (folded) continue;
    for (const child of children) lines.push({ task: child, depth: 1, subtasks: 0, collapsed: false });
  }
  return lines;
}
