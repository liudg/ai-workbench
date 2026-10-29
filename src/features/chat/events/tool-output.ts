/**
 * 工具输出的预览。长输出只留结尾，报错和测试结果通常在最后。
 * 输出框本身限高滚动；这里只决定交给它多少行。
 */
const PREVIEW_LINES = 120;
const PREVIEW_CHARS = 8_000;

export interface OutputPreview {
  text: string;
  /** 前面省掉的行数。0 表示整段都在。 */
  hiddenLines: number;
}

export function outputPreview(text: string): OutputPreview {
  const lines = text.split("\n");
  if (lines.length <= PREVIEW_LINES && text.length <= PREVIEW_CHARS) return { text, hiddenLines: 0 };
  let kept = lines.slice(-PREVIEW_LINES);
  let joined = kept.join("\n");
  while (kept.length > 1 && joined.length > PREVIEW_CHARS) {
    kept = kept.slice(1);
    joined = kept.join("\n");
  }
  if (joined.length > PREVIEW_CHARS) joined = joined.slice(-PREVIEW_CHARS);
  return { text: joined, hiddenLines: lines.length - kept.length };
}

const COMMAND_LINES = 3;
const COMMAND_CHARS = 240;

/** 命令超过三行或很长时先收起，点开再看全文。 */
export function commandIsLong(text: string): boolean {
  return text.split("\n").length > COMMAND_LINES || text.length > COMMAND_CHARS;
}
