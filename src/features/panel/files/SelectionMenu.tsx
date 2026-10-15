import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { formatSelectionQuote } from "./selection-quote";

interface MenuBox {
  top: number;
  left: number;
  above: boolean;
  quote: string;
}

/** 选中预览文字后只提供「添加到对话」。复制走浏览器自己的选区。 */
export function SelectionMenu({
  rootRef,
  path,
  onAdd,
}: {
  rootRef: RefObject<HTMLElement | null>;
  path: string;
  onAdd: (quote: string) => void;
}) {
  const [box, setBox] = useState<MenuBox | null>(null);

  useEffect(() => {
    const read = () => {
      const root = rootRef.current;
      if (!root) {
        setBox(null);
        return;
      }
      const next = quoteFromSelection(root, path);
      setBox(next);
    };
    const hide = () => setBox(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("selectionchange", read);
    window.addEventListener("keydown", onKey);
    const root = rootRef.current;
    root?.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("selectionchange", read);
      window.removeEventListener("keydown", onKey);
      root?.removeEventListener("scroll", hide, true);
    };
  }, [path, rootRef]);

  if (!box || typeof document === "undefined") return null;
  return createPortal(
    <div
      role="menu"
      data-selection-menu
      className="fixed z-[80] rounded-lg border border-[#2a2a2a] bg-[#1b1b1b] px-1 py-1 shadow-lg"
      style={{
        top: box.top,
        left: box.left,
        transform: box.above ? "translate(-50%, calc(-100% - 6px))" : "translate(-50%, 6px)",
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        data-add-selection
        className="rounded-md px-2.5 py-1 text-xs text-[#e8e8e8] hover:bg-white/10"
        onClick={() => {
          onAdd(box.quote);
          setBox(null);
          window.getSelection()?.removeAllRanges();
        }}
      >
        {DESKTOP_ZH.addSelectionToChat}
      </button>
    </div>,
    document.body,
  );
}

function quoteFromSelection(root: HTMLElement, path: string): MenuBox | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const lines = lineNumbers(root, range, text);
  const quote = formatSelectionQuote(path, text, lines.start, lines.end);
  if (!quote) return null;
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const left = Math.min(window.innerWidth - 56, Math.max(56, rect.left + rect.width / 2));
  const above = rect.top > 48;
  const top = above ? rect.top : rect.bottom;
  return { top, left, above, quote };
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
