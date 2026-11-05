import { selectionDraft, type SelectionDraft } from "./selection-quote";

/** 预览选区写成带路径的代码引用。 */
export function fileSelectionDraft(root: HTMLElement, path: string): SelectionDraft | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const host =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (host?.closest("input, textarea") || document.activeElement?.closest("input, textarea")) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const lines = lineNumbers(root, range, text);
  return selectionDraft(path, text, lines.start, lines.end);
}

function lineNumbers(root: HTMLElement, range: Range, text: string): { start: number | null; end: number | null } {
  const startRow = lineAttr(range.startContainer);
  const endRow = lineAttr(range.endContainer);
  if (startRow && endRow) return { start: Math.min(startRow, endRow), end: Math.max(startRow, endRow) };
  const pre = root.querySelector("pre");
  if (!pre || !pre.contains(range.startContainer)) return { start: null, end: null };
  const before = document.createRange();
  before.selectNodeContents(pre);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().split("\n").length;
  const end = start + Math.max(text.split("\n").length - 1, 0);
  return { start, end };
}

function lineAttr(node: Node): number | null {
  const element = node instanceof Element ? node : node.parentElement;
  const row = element?.closest("[data-source-line]");
  if (!row) return null;
  const line = Number(row.getAttribute("data-source-line"));
  return Number.isFinite(line) && line >= 1 ? line : null;
}
