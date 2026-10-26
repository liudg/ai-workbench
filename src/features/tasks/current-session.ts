import type { TaskEntry, TaskSession } from "./types";

/** 任务现在用的会话：最后建的那个。中途换 Agent 时前面的会话留作历史。 */
export function currentSession(task: TaskEntry): TaskSession | undefined {
  return task.sessions[task.sessions.length - 1];
}
