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
      className="wb-popover fixed z-50 w-52 overflow-hidden rounded-xl p-1"
      style={{ top: -9999, left: 8 }}
    >
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm text-wb-fg transition-colors hover:bg-wb-hover"
        onClick={() => void onPick()}
      >
        添加照片和文件
      </button>
    </div>
  );
}
