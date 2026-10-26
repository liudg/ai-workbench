import { TOPIC_TASKS, useTopic } from "@/lib/daemon";
import type { TaskEntry } from "./types";

const NO_TASKS: TaskEntry[] = [];

/** 全部任务，归档的也在里面。还没收到第一份快照时 `loading` 为 true。 */
export function useTasks() {
  const tasks = useTopic<TaskEntry[]>(TOPIC_TASKS);
  return { tasks: tasks ?? NO_TASKS, loading: tasks === undefined };
}
