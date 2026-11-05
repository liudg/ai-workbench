import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { useDismissLayer } from "./useDismissLayer";

export type ContextMenuItem =
  | { id: string; label: string; onSelect: () => void; disabled?: boolean; shortcut?: string }
  | { id: string; separator: true };

/**
 * 右键菜单：文件树、文件内容、聊天消息和输入框共用。选中一项后自己关掉。
 * 打开时不选中任何一项，焦点留在原处；按上下键才开始在菜单里移动。
 */
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const menu = menuRef.current;
      if (!menu) return;
      event.preventDefault();
      event.stopPropagation();
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")];
      if (buttons.length === 0) return;
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        at < 0
          ? event.key === "ArrowDown"
            ? 0
            : buttons.length - 1
          : (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
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
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.map((item) =>
        "separator" in item ? (
          <div key={item.id} role="separator" className="my-1 h-px bg-zinc-800" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-menu-item={item.id}
            disabled={item.disabled}
            className={cn(
              "flex w-full items-center gap-6 whitespace-nowrap px-3 py-1.5 text-left text-xs text-zinc-100 outline-none",
              "hover:bg-zinc-800 focus-visible:bg-zinc-800 disabled:text-zinc-600 disabled:hover:bg-transparent",
            )}
            onClick={() => {
              onCloseRef.current();
              item.onSelect();
            }}
          >
            <span className="min-w-0 flex-1">{item.label}</span>
            {item.shortcut ? <span className="text-[11px] text-zinc-500">{item.shortcut}</span> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
