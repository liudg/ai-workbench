import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { useDismissLayer } from "./useDismissLayer";

export type ContextMenuItem =
  | { id: string; label: string; onSelect: () => void; disabled?: boolean }
  | { id: string; separator: true };

/** 面板里的右键菜单：文件树、变更树和文件内容共用。选中一项后自己关掉。 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: readonly ContextMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useDismissLayer(true, onClose);
  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onCloseRef.current();
    };
    const onBlur = () => onCloseRef.current();
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    menu.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(8, x), window.innerWidth - width - 8);
    let top = y;
    if (top + height > window.innerHeight - 8) top = Math.max(8, y - height);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [x, y]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-context-menu
      className="fixed z-[80] min-w-40 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
      style={{ top: -9999, left: 8 }}
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
        if (buttons.length === 0) return;
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        buttons[(at + step + buttons.length) % buttons.length]?.focus();
      }}
    >
      {items.map((item) =>
        "separator" in item ? (
          <div key={item.id} role="separator" className="my-1 h-px bg-zinc-800" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            data-menu-item={item.id}
            disabled={item.disabled}
            className={cn(
              "flex w-full items-center whitespace-nowrap px-3 py-1.5 text-left text-xs text-zinc-100 outline-none",
              "hover:bg-zinc-800 focus:bg-zinc-800 disabled:text-zinc-600 disabled:hover:bg-transparent",
            )}
            onClick={() => {
              onCloseRef.current();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
