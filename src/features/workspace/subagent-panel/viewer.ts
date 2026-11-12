import { Bot } from "lucide-react";

import { registerViewer, type PanelViewer } from "@/features/panel/headless";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { SUBAGENTS_VIEWER } from "./open";
import { SubagentsTab } from "./SubagentsTab";

/** 每个会话一个子智能体标签。关掉标签不影响它们。 */
const subagentsViewer: PanelViewer = {
  id: SUBAGENTS_VIEWER,
  match: (target) => (target.kind === "custom" && target.type === SUBAGENTS_VIEWER ? 100 : 0),
  icon: Bot,
  title: () => DESKTOP_ZH.subagents,
  View: SubagentsTab,
};

let registered = false;

export function registerSubagentsViewer() {
  if (registered) return;
  registered = true;
  registerViewer(subagentsViewer);
}
