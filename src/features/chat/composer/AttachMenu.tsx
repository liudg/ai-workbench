import type { RefObject } from "react";

export function AttachMenu({
  menuRef,
  onPick,
}: {
  menuRef: RefObject<HTMLDivElement>;
  onPick: () => void;
}) {
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="添加附件"
      className="fixed z-50 w-52 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
      style={{ top: -9999, left: 8 }}
    >
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
        onClick={() => void onPick()}
      >
        添加照片和文件
      </button>
    </div>
  );
}
