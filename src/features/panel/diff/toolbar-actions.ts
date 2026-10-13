/** 差异工具栏右侧图标，从左到右跟 Codex 桌面截图一致。 */
export const DIFF_TOOLBAR_ICON_IDS = [
  "options",
  "jump",
  "refresh",
  "wrap",
  "expand",
  "layout",
  "files",
] as const;

export type DiffToolbarIconId = (typeof DIFF_TOOLBAR_ICON_IDS)[number];
