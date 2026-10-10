import { useRef, useState } from "react";
import { Ellipsis, Plus } from "lucide-react";

import { useWorkbench } from "@/store";
import { useDismiss } from "../use-dismiss";

export function ProjectHeader() {
  const openDialog = useWorkbench((s) => s.openDialog);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = () => setMenuOpen(false);
  useDismiss(menuOpen, menuRef, closeMenu);

  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-2">
      <span className="px-1 text-[13px] font-medium text-zinc-300">项目</span>
      <div className="flex items-center gap-1">
        <div ref={menuRef} className="relative">
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-200 transition-colors hover:bg-zinc-800/70 hover:text-white"
            aria-label="更多"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Ellipsis className="h-4 w-4" strokeWidth={2} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 w-36 rounded-xl border border-zinc-700/80 bg-zinc-900 px-3 py-2 text-xs text-zinc-500 shadow-xl shadow-black/40">
              暂无更多操作
            </div>
          )}
        </div>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-100 transition-colors hover:bg-zinc-800/70 hover:text-white"
          aria-label="创建项目"
          title="创建项目"
          onClick={() => openDialog("create")}
        >
          <Plus className="h-[18px] w-[18px]" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
