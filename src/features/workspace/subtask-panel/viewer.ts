import { Split } from "lucide-react";

import { registerViewer, type OpenTarget, type PanelViewer } from "@/features/panel/core/registry";
import { SUBTASK_VIEWER, type SubtaskPayload } from "./open";
import { SubtaskTab } from "./SubtaskTab";

function taskIdOf(target: OpenTarget): string | null {
  if (target.kind !== "custom" || target.type !== SUBTASK_VIEWER) return null;
  const data = target.data as Partial<SubtaskPayload> | undefined;
  return typeof data?.taskId === "string" ? data.taskId : null;
}

/** 面板里的一个子任务：完整的时间线和作曲栏，关掉标签不影响子任务。 */
const subtaskViewer: PanelViewer<SubtaskPayload> = {
  id: SUBTASK_VIEWER,
  match: (target) => (taskIdOf(target) ? 100 : 0),
  icon: Split,
  title: (payload) => payload.title?.trim() || "子任务",
  View: SubtaskTab,
};

let registered = false;

export function registerSubtaskViewer() {
  if (registered) return;
  registered = true;
  registerViewer(subtaskViewer);
}
