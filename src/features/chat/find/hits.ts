export interface TextHit {
  node: Text;
  start: number;
  end: number;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** 空关键词不匹配。大小写不敏感，按字面量找，不把关键词当正则。 */
export function collectTextHits(root: Node, query: string): TextHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: TextHit[] = [];
  walk(root, needle, hits);
  return hits;
}

/**
 * 在目标消息节点内挑选能实际命中的查询词：
 * 优先整串命中；其次剥掉行内反引号与 `**` 后的整串；
 * 若 FTS 多词查询整串未连续出现，回退到在目标节点内命中的最长子词（含剥掉行内反引号/`**` 的子词）；
 * 若所有词均未出现在可见文本中（例如被剥离的 Markdown URL），返回 `null` 以免弹出 `0/0` 或误滚到其他消息。
 */
export function resolveQueryInTargetNode(targetNode: Node, rawQuery: string): string | null {
  const trimmed = rawQuery.trim();
  if (!trimmed) return null;
  if (collectTextHits(targetNode, trimmed).length > 0) return rawQuery;
  const stripped = trimmed.replace(/\*\*|`/g, "").trim();
  if (stripped && stripped !== trimmed && collectTextHits(targetNode, stripped).length > 0) {
    return stripped;
  }
  const terms = trimmed
    .split(/\s+/)
    .flatMap((term) => {
      const clean = term.replace(/\*\*|`/g, "");
      return clean && clean !== term ? [term, clean] : [term];
    })
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const term of terms) {
    if (collectTextHits(targetNode, term).length > 0) return term;
  }
  return null;
}

/** 到头后绕回第一条。Codex 是否绕回未观察。 */
export function stepHit(index: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return 0;
  const base = index < 0 ? (direction === 1 ? -1 : 0) : index;
  return (base + direction + count) % count;
}

function walk(node: Node, needle: string, hits: TextHit[]) {
  if (node.nodeType === TEXT_NODE) {
    const text = node.textContent ?? "";
    if (!text) return;
    const lower = text.toLowerCase();
    let from = 0;
    while (from <= lower.length - needle.length) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      hits.push({ node: node as Text, start: at, end: at + needle.length });
      from = at + needle.length;
    }
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) {
    for (const child of node.childNodes) walk(child, needle, hits);
    return;
  }
  const element = node as Element;
  if (!isSearchableElement(element)) return;
  for (const child of element.childNodes) walk(child, needle, hits);
}

function isSearchableElement(element: Element): boolean {
  const tag = element.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "INPUT") return false;
  if (element.hasAttribute("hidden")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  if (element.hasAttribute("data-thread-find")) return false;
  if (element.hasAttribute("data-message-footer") || element.hasAttribute("data-hover-actions")) return false;
  return true;
}
