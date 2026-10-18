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
  return true;
}
