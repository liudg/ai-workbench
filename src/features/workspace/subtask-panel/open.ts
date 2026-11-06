// 子任务放到右侧面板里，和父会话并排看。照 herdr `skills/herdr/SKILL.md` 把被叫来的 Agent 开在旁边窗格、
// Claude Code 桌面版把嵌套会话拖到分屏。

import type { OpenTarget } from "@/features/panel/core/registry";
import { usePanelStore } from "@/features/panel/state/store";

export const SUBTASK_VIEWER = "subtask";

export interface SubtaskPayload {
  taskId: string;
  title?: string;
}

export function subtaskTarget(taskId: string): OpenTarget {
  return { kind: "custom", type: SUBTASK_VIEWER, key: taskId, data: { taskId } satisfies SubtaskPayload };
}

const NO_CONTEXT = { projectId: "", projectPath: "", sessionFiles: [] };

export function openSubtaskBeside(mainSessionId: string, taskId: string) {
  void usePanelStore.getState().panelOpenTarget(mainSessionId, subtaskTarget(taskId), NO_CONTEXT);
}
