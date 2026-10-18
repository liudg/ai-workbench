import type { TextHit } from "./hits.ts";

/** 用 mark 包住命中，时间线里直接看得见。 */
export function paintThreadHits(hits: readonly TextHit[], current: number): void {
  paintMarks(hits, current);
}

export function clearThreadHighlights(root: ParentNode | null): void {
  if (root) clearThreadMarks(root);
}

export function clearThreadMarks(root: ParentNode): void {
  const marks = root.querySelectorAll("mark[data-thread-find-mark]");
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    const text = mark.ownerDocument.createTextNode(mark.textContent ?? "");
    parent.replaceChild(text, mark);
    parent.normalize();
  });
}

export function scrollHitIntoView(hit: TextHit, container: HTMLElement): void {
  const parent = hit.node.parentElement;
  if (!parent) return;
  const rect = parent.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  if (rect.top >= box.top + 8 && rect.bottom <= box.bottom - 8) return;
  parent.scrollIntoView({ block: "center", inline: "nearest" });
}

function paintMarks(hits: readonly TextHit[], current: number) {
  const grouped = new Map<Text, { start: number; end: number; current: boolean }[]>();
  hits.forEach((hit, index) => {
    const list = grouped.get(hit.node) ?? [];
    list.push({ start: hit.start, end: hit.end, current: index === current });
    grouped.set(hit.node, list);
  });
  for (const [node, list] of grouped) {
    const parent = node.parentNode;
    if (!parent) continue;
    const text = node.textContent ?? "";
    const doc = node.ownerDocument;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    const ordered = [...list].sort((left, right) => left.start - right.start);
    for (const hit of ordered) {
      if (hit.start < cursor || hit.end > text.length) continue;
      if (hit.start > cursor) fragment.append(doc.createTextNode(text.slice(cursor, hit.start)));
      const mark = doc.createElement("mark");
      mark.dataset.threadFindMark = hit.current ? "current" : "hit";
      mark.textContent = text.slice(hit.start, hit.end);
      fragment.append(mark);
      cursor = hit.end;
    }
    if (cursor < text.length) fragment.append(doc.createTextNode(text.slice(cursor)));
    parent.replaceChild(fragment, node);
  }
}

