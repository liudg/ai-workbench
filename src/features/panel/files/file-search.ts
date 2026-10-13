export interface HighlightPart {
  text: string;
  hit: boolean;
}

/** 大小写不敏感地标出查询词。查询为空时整段都不算命中。 */
export function highlightParts(text: string, query: string): HighlightPart[] {
  const needle = query.trim();
  if (!needle) return text ? [{ text, hit: false }] : [];
  const lower = text.toLowerCase();
  const want = needle.toLowerCase();
  if (!want || lower.length !== text.length) {
    return text ? [{ text, hit: false }] : [];
  }
  const parts: HighlightPart[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const at = lower.indexOf(want, cursor);
    if (at < 0) {
      parts.push({ text: text.slice(cursor), hit: false });
      break;
    }
    if (at > cursor) parts.push({ text: text.slice(cursor, at), hit: false });
    parts.push({ text: text.slice(at, at + want.length), hit: true });
    cursor = at + want.length;
  }
  return parts.filter((part) => part.text.length > 0);
}

export function moveSearchCursor(current: number, count: number, key: "ArrowUp" | "ArrowDown"): number {
  if (count <= 0) return 0;
  if (key === "ArrowDown") return Math.min(count - 1, current + 1);
  return Math.max(0, current - 1);
}
