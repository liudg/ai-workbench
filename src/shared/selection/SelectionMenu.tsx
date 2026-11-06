import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { TextSnippetDraft } from "@/shared/text-snippet";
import {
  selectionMenuPoint,
  selectionMenuPosition,
  selectionMenuUpdate,
  type SelectionGesture,
  type SelectionMenuPoint,
} from "./selection-menu";

interface MenuBox {
  point: SelectionMenuPoint;
  draft: TextSnippetDraft;
}

export interface SelectionAction {
  id: string;
  label: string;
  /** range 是点下去那一刻的选区，菜单收起后选区就清掉了。 */
  onSelect: (draft: TextSnippetDraft, range: Range | null) => void;
}

/** 选中文字后浮出的一排操作，由各个视图给出。复制走浏览器自己的选区。 */
export function SelectionMenu({
  rootRef,
  readDraft,
  actions,
}: {
  rootRef: RefObject<HTMLElement | null>;
  readDraft: (root: HTMLElement) => TextSnippetDraft | null;
  /** 一项都没有时不出菜单。 */
  actions: (draft: TextSnippetDraft) => readonly SelectionAction[];
}) {
  const readDraftRef = useRef(readDraft);
  readDraftRef.current = readDraft;
  const menuRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<MenuBox | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!box || !menu) return;
    const apply = () => {
      const node = menuRef.current;
      if (!node) return;
      const next = selectionMenuPosition(
        box.point,
        { width: window.innerWidth, height: window.innerHeight },
        { width: node.offsetWidth, height: node.offsetHeight },
      );
      setPlace((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [box]);

  useEffect(() => {
    let dragging = false;
    let frame = 0;
    let releasedAt: SelectionMenuPoint | null = null;
    let ignoreChange = false;

    const show = (next: MenuBox | null) => {
      setBox((prev) => {
        if (!next) return null;
        if (
          prev &&
          prev.point.x === next.point.x &&
          prev.point.y === next.point.y &&
          prev.draft.path === next.draft.path &&
          prev.draft.quote === next.draft.quote
        ) {
          return prev;
        }
        return next;
      });
    };

    const read = () => {
      const root = rootRef.current;
      if (!root) {
        show(null);
        return;
      }
      const draft = readDraftRef.current(root);
      if (!draft) {
        show(null);
        return;
      }
      const point = selectionMenuPoint(releasedAt, selectionEndPoint());
      if (!point) {
        show(null);
        return;
      }
      show({ point, draft });
    };

    const apply = (event: SelectionGesture, inside = true, point: SelectionMenuPoint | null = null) => {
      const wasDragging = dragging;
      const next = selectionMenuUpdate(event, dragging, inside);
      dragging = next.dragging;
      if (event === "up" && wasDragging && point) releasedAt = point;
      if (next.update === "ignore") return;
      if (next.update === "clear") {
        cancelAnimationFrame(frame);
        releasedAt = null;
        if (!dragging) ignoreChange = true;
        show(null);
        return;
      }
      ignoreChange = false;
      read();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!dragging && !ignoreChange) read();
      });
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[data-selection-menu]")) return;
      const root = rootRef.current;
      ignoreChange = false;
      const inside = Boolean(root && target instanceof Node && root.contains(target));
      apply("down", inside);
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      apply("up", true, { x: event.clientX, y: event.clientY });
    };
    const onChange = () => {
      if (ignoreChange && !dragging) return;
      apply("change");
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        apply("cancel");
        return;
      }
      if (movesSelection(event)) {
        releasedAt = null;
        ignoreChange = false;
      }
    };
    const onScroll = () => {
      if (dragging) return;
      cancelAnimationFrame(frame);
      releasedAt = null;
      ignoreChange = true;
      show(null);
    };
    const onBlur = () => {
      if (dragging) apply("up");
    };

    document.addEventListener("selectionchange", onChange);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    const root = rootRef.current;
    root?.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      root?.removeEventListener("scroll", onScroll, true);
    };
  }, [rootRef]);

  const items = box ? actions(box.draft) : [];
  if (!box || items.length === 0 || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-selection-menu
      className="fixed z-[80] flex items-center rounded-lg border border-[#2a2a2a] bg-[#1b1b1b] px-1 py-1 shadow-lg"
      style={{
        top: place?.top ?? -9999,
        left: place?.left ?? 0,
        visibility: place ? "visible" : "hidden",
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {index > 0 ? <span className="mx-0.5 h-3.5 w-px bg-[#333]" /> : null}
          <button
            type="button"
            role="menuitem"
            data-selection-action={item.id}
            className="rounded-md px-2.5 py-1 text-xs text-[#e8e8e8] hover:bg-white/10"
            onClick={() => {
              const selection = window.getSelection();
              const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
              setBox(null);
              selection?.removeAllRanges();
              item.onSelect(box.draft, range);
            }}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

function movesSelection(event: KeyboardEvent): boolean {
  if (event.key === "a" && (event.metaKey || event.ctrlKey)) return true;
  return (
    event.key === "ArrowLeft" ||
    event.key === "ArrowRight" ||
    event.key === "ArrowUp" ||
    event.key === "ArrowDown" ||
    event.key === "Home" ||
    event.key === "End" ||
    event.key === "PageUp" ||
    event.key === "PageDown"
  );
}

function selectionEndPoint(): SelectionMenuPoint | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const rects = range.getClientRects();
  let rect: DOMRect | null = null;
  for (let index = rects.length - 1; index >= 0; index -= 1) {
    const item = rects[index];
    if (!item) continue;
    if (item.width !== 0 || item.height !== 0) {
      rect = item;
      break;
    }
  }
  if (!rect) {
    const box = range.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return null;
    rect = box;
  }
  return { x: rect.right, y: rect.bottom };
}
