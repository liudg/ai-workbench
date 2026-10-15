import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";

/** 工作区树和变更树共用的右键菜单。只有「添加到聊天」。 */
export function FileContextMenu({
  x,
  y,
  onAdd,
  onClose,
}: {
  x: number;
  y: number;
  onAdd: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [onClose]);
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
      data-file-context-menu
      className="fixed z-[80] w-40 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
      style={{ top: -9999, left: 8 }}
    >
      <button
        type="button"
        role="menuitem"
        data-add-to-chat
        className="flex w-full items-center px-3 py-1.5 text-left text-xs text-zinc-100 hover:bg-zinc-800"
        onClick={onAdd}
      >
        {DESKTOP_ZH.addToChat}
      </button>
    </div>,
    document.body,
  );
}
