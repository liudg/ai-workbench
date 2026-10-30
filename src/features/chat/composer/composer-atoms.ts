// 输入框里的技能和文件引用是一个整体：删除一次删掉整个，方向键一步跨过，光标和选区不落在中间。

import type { ComposerToken } from "./file-refs.ts";

export interface AtomRange {
  start: number;
  end: number;
}

export function atomRanges(tokens: readonly ComposerToken[]): AtomRange[] {
  const ranges: AtomRange[] = [];
  let offset = 0;
  for (const token of tokens) {
    if (token.kind !== "text") ranges.push({ start: offset, end: offset + token.text.length });
    offset += token.text.length;
  }
  return ranges;
}

function inside(range: AtomRange, at: number): boolean {
  return at > range.start && at < range.end;
}

/**
 * 删除键要删掉的范围。光标紧贴标签（Backspace 在它后面、Delete 在它前面）时删整个；
 * 选区压到半个标签时补成整个。返回 null 时交给浏览器照常删。
 */
export function atomDeleteRange(
  ranges: readonly AtomRange[],
  start: number,
  end: number,
  key: "Backspace" | "Delete",
): AtomRange | null {
  if (start === end) {
    const hit = ranges.find((range) =>
      key === "Backspace" ? start === range.end || inside(range, start) : start === range.start || inside(range, start),
    );
    return hit ? { start: hit.start, end: hit.end } : null;
  }
  const grown = growSelection(ranges, start, end);
  return grown.start !== start || grown.end !== end ? grown : null;
}

/** 删掉标签后前后会剩两个空格（或开头剩一个）时，连后面那个空格一起删。 */
export function withTrailingSpace(text: string, range: AtomRange): AtomRange {
  const before = range.start === 0 ? " " : text[range.start - 1];
  const after = text[range.end];
  return before === " " && after === " " ? { start: range.start, end: range.end + 1 } : range;
}

/** 选区两头落在标签中间时，往外补到整个标签。 */
export function growSelection(ranges: readonly AtomRange[], start: number, end: number): AtomRange {
  let from = start;
  let to = end;
  for (const range of ranges) {
    if (inside(range, from)) from = range.start;
    if (inside(range, to)) to = range.end;
  }
  return { start: from, end: to };
}

/** 光标落在标签中间时挪到近的那一头。 */
export function snapCaret(ranges: readonly AtomRange[], at: number): number {
  const hit = ranges.find((range) => inside(range, at));
  if (!hit) return at;
  return at - hit.start <= hit.end - at ? hit.start : hit.end;
}

/** 左右方向键：贴着标签时一步跨到另一头。返回 null 时交给浏览器。 */
export function atomArrow(ranges: readonly AtomRange[], at: number, key: "ArrowLeft" | "ArrowRight"): number | null {
  const hit = ranges.find((range) =>
    key === "ArrowLeft" ? at === range.end || inside(range, at) : at === range.start || inside(range, at),
  );
  if (!hit) return null;
  return key === "ArrowLeft" ? hit.start : hit.end;
}
