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

/**
 * 存下的目录先给 `show`，现探的到了再给一次；现探先到时，晚到的存货不再给。
 * 现探失败时，已经给过存货就算成功，一样都没给过才 reject。
 */
export function storedThenProbed(
  stored: Promise<AgentCatalog | null>,
  probed: Promise<AgentCatalog>,
  show: (catalog: AgentCatalog) => void,
): Promise<void> {
  let settled = false;
  const shownStored = stored.then(
    (catalog) => {
      if (settled || !catalog) return false;
      show(catalog);
      return true;
    },
    () => false,
  );
  return probed.then(
    (catalog) => {
      settled = true;
      show(catalog);
    },
    async (error: unknown) => {
      const shown = await shownStored;
      settled = true;
      if (!shown) throw error;
    },
  );
}
