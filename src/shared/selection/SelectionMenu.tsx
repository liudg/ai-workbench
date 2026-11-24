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

export interface SelectionBarItem {
  id: string;
  label: string;
  onClick: (draft: TextSnippetDraft, dismiss: () => void) => void;
}

export interface SelectionBarSourceHandlers {
  onChange: () => void;
  onClear: () => void;
  onScroll: () => void;
  resetKeyboardPoint: () => void;
}

/** 选区浮动操作条的定位、拖拽/释放手势状态机与 Portal 渲染基础设施。 */
export function FloatingSelectionBar({
  rootRef,
  sourceKey,
  enabled = true,
  suppressed = false,
  watchWheel = false,
  isTargetInside,
  readSelection,
  subscribeSource,
  items: resolveItems,
}: {
  rootRef: RefObject<HTMLElement | null>;
  sourceKey?: unknown;
  enabled?: boolean;
  suppressed?: boolean;
  watchWheel?: boolean;
  isTargetInside?: (root: HTMLElement, target: EventTarget | null) => boolean;
  readSelection: (root: HTMLElement) => {
    draft: TextSnippetDraft;
    fallbackPoint: () => SelectionMenuPoint | null;
  } | null;
  subscribeSource: (handlers: SelectionBarSourceHandlers) => () => void;
  items: (draft: TextSnippetDraft) => readonly SelectionBarItem[];
}) {
  const callbacksRef = useRef({ isTargetInside, readSelection, subscribeSource });
  callbacksRef.current = { isTargetInside, readSelection, subscribeSource };
  const menuRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<MenuBox | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (suppressed) setBox(null);
  }, [suppressed]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!box || suppressed || !menu) return;
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
  }, [box, suppressed]);

  useEffect(() => {
    if (!enabled) {
      setBox(null);
      return;
    }
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
      const selection = callbacksRef.current.readSelection(root);
      if (!selection) {
        show(null);
        return;
      }
      const point = selectionMenuPoint(releasedAt, selection.fallbackPoint());
      if (!point) {
        show(null);
        return;
      }
      show({ point, draft: selection.draft });
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
      const checkInside = callbacksRef.current.isTargetInside;
      const inside = Boolean(
        root &&
          (checkInside ? checkInside(root, target) : target instanceof Node && root.contains(target)),
      );
      apply("down", inside);
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      apply("up", true, { x: event.clientX, y: event.clientY });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        apply("cancel");
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

    const disposeSource = callbacksRef.current.subscribeSource({
      onChange: () => {
        if (ignoreChange && !dragging) return;
        apply("change");
      },
      onClear: () => {
        cancelAnimationFrame(frame);
        releasedAt = null;
        show(null);
      },
      onScroll,
      resetKeyboardPoint: () => {
        releasedAt = null;
        ignoreChange = false;
      },
    });

    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    const root = rootRef.current;
    root?.addEventListener("scroll", onScroll, true);
    if (watchWheel) {
      root?.addEventListener("wheel", onScroll, { passive: true, capture: true });
    }
    return () => {
      cancelAnimationFrame(frame);
      disposeSource();
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
      root?.removeEventListener("scroll", onScroll, true);
      if (watchWheel) {
        root?.removeEventListener("wheel", onScroll, true);
      }
    };
  }, [enabled, rootRef, sourceKey, watchWheel]);

  const items = box && !suppressed ? resolveItems(box.draft) : [];
  if (!box || suppressed || items.length === 0 || typeof document === "undefined") return null;
  const dismiss = () => setBox(null);
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-selection-menu
      className="wb-popover fixed z-[80] flex items-center p-1"
      style={{
        top: place?.top ?? -9999,
        left: place?.left ?? 0,
        visibility: place ? "visible" : "hidden",
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {index > 0 ? <span className="mx-0.5 h-3.5 w-px bg-wb-border" /> : null}
          <button
            type="button"
            role="menuitem"
            data-selection-action={item.id}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-wb-fg hover:bg-wb-hover"
            onClick={() => item.onClick(box.draft, dismiss)}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
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
  return (
    <FloatingSelectionBar
      rootRef={rootRef}
      readSelection={(root) => {
        const draft = readDraft(root);
        return draft ? { draft, fallbackPoint: selectionEndPoint } : null;
      }}
      subscribeSource={({ onChange, resetKeyboardPoint }) => {
        const onKey = (event: KeyboardEvent) => {
          if (movesSelection(event)) resetKeyboardPoint();
        };
        document.addEventListener("selectionchange", onChange);
        window.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("selectionchange", onChange);
          window.removeEventListener("keydown", onKey);
        };
      }}
      items={(draft) =>
        actions(draft).map((item) => ({
          id: item.id,
          label: item.label,
          onClick: (currentDraft, dismiss) => {
            const selection = window.getSelection();
            const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
            dismiss();
            selection?.removeAllRanges();
            item.onSelect(currentDraft, range);
          },
        }))
      }
    />
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
