import { invoke } from "./call";
import type { Backend, TaskFolder } from "./contract";

export const chatCommands: Pick<Backend, "taskFolder" | "setTaskFolder"> = {
  taskFolder: () => invoke<TaskFolder>("task_folder"),
  setTaskFolder: (path) => invoke<TaskFolder>("set_task_folder", { path }),
};
