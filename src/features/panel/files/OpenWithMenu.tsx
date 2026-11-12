import { useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useAnchoredLayer } from "../core/useAnchoredLayer";
import { useDismissLayer } from "@/shared/menu/useDismissLayer";
import type { OpenWithAction, OpenWithItem } from "./open-with";

/** 「打开」胶囊的下拉。定位和点外面关掉都只属于这个菜单。 */
export function OpenWithMenu({
  menuId,
  anchorRef,
  items,
  onSelect,
  onClose,
}: {
  menuId: string;
  anchorRef: RefObject<HTMLButtonElement | null>;
  items: readonly OpenWithItem[];
  onSelect: (mode: OpenWithAction) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useAnchoredLayer(true, anchorRef, menuRef, items.map((item) => item.id).join(","));
  useDismissLayer(true, onClose);
  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [anchorRef]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      data-open-with-menu
      className="wb-popover fixed z-[80] min-w-[168px] rounded-xl py-1 text-wb-fg"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          data-open-with-action={item.id}
          className="flex w-full items-center px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-wb-hover"
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
