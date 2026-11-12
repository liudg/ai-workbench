// 子智能体在右侧面板里是一个标签：列出这个会话开出的嵌套会话和 Agent 自带的子 Agent，点一行在标签里看详情。
// 照 Codex 桌面端的「子智能体」标签。

import { create } from "zustand";

import { usePanelStore, type OpenTarget } from "@/features/panel/headless";

export const SUBAGENTS_VIEWER = "subagents";

export const subagentsTarget: OpenTarget = { kind: "custom", type: SUBAGENTS_VIEWER };

/** 标签里正在看的那一个。`taskId` 是它所在的任务，时间线从那里取。 */
export type SubagentFocus =
  | { kind: "task"; taskId: string }
  | { kind: "native"; taskId: string; sessionId: string; subagentId: string };

/** 主会话 id → 正在看的详情。没有就是列表。只是界面状态。 */
const useFocusStore = create<Record<string, SubagentFocus | undefined>>()(() => ({}));

export function useSubagentFocus(mainSessionId: string): SubagentFocus | undefined {
  return useFocusStore((state) => state[mainSessionId]);
}

export function focusSubagent(mainSessionId: string, focus: SubagentFocus | undefined) {
  useFocusStore.setState({ [mainSessionId]: focus });
}

const NO_CONTEXT = { projectId: "", projectPath: "", sessionFiles: [] };

/** 打开这个会话的子智能体标签，落在 `focus` 的详情上。 */
export function openSubagentPanel(mainSessionId: string, focus: SubagentFocus) {
  focusSubagent(mainSessionId, focus);
  void usePanelStore.getState().panelOpenTarget(mainSessionId, subagentsTarget, NO_CONTEXT);
}
