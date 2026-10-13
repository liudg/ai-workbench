/** 差异工具栏右侧图标，从左到右跟录屏一致。 */
export const DIFF_TOOLBAR_ICON_IDS = [
  "options",
  "load-full",
  "refresh",
  "wrap",
  "expand",
  "unified",
  "files",
] as const;

export type DiffToolbarIconId = (typeof DIFF_TOOLBAR_ICON_IDS)[number];
