import type { AgentCatalog } from "../types/index.ts";

/** 有模型就显示模型名。只有确认没有目录时才显示「暂无模型」，加载中不显示。 */
export function modelButtonLabel(
  selectedLabel: string | undefined,
  catalog: AgentCatalog | undefined,
  notice: string | null,
): string {
  if (selectedLabel) return selectedLabel;
  if ((catalog && catalog.models.length === 0) || notice) return "暂无模型";
  return "读取模型…";
}
