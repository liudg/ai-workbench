/** 回合末尾堆在一起的文件引用。不多于 4 个全显示，再多就先显示 3 个。 */

export const FILE_CITE_SHOW_ALL = 4;
export const FILE_CITE_PREVIEW = 3;

export function visibleFileCiteCount(total: number, revealed: boolean): number {
  if (total <= 0) return 0;
  if (revealed || total <= FILE_CITE_SHOW_ALL) return total;
  return FILE_CITE_PREVIEW;
}
