import { useCallback, useRef, useState } from "react";
import { RefreshCw, Settings } from "lucide-react";

import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import { useWorkbench } from "@/store";
import { useDismiss } from "../use-dismiss";

export function AccountMenu() {
  const checkUpdates = useWorkbench((s) => s.checkUpdates);
  const openSettings = useWorkbench((s) => s.openSettings);
  const checking = useWorkbench((s) => s.update.kind === "checking");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, rootRef, close);

  return (
    <div ref={rootRef} className="relative">
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-56 overflow-hidden rounded-2xl border border-zinc-700/80 bg-zinc-900 py-1.5 shadow-2xl shadow-black/50">
          <button
            type="button"
            className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm text-zinc-100 transition-colors hover:bg-zinc-800/90"
            onClick={() => {
              setOpen(false);
              openSettings();
            }}
          >
            <Settings className="h-4 w-4 shrink-0 text-zinc-400" />
            <span>设置</span>
          </button>
          <div className="mx-2 border-t border-zinc-800" />
          <button
            type="button"
            className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm text-zinc-100 transition-colors hover:bg-zinc-800/90"
            onClick={() => {
              setOpen(false);
              checkUpdates(true);
            }}
          >
            <RefreshCw
              className={cn(
                "h-4 w-4 shrink-0 text-zinc-400",
                checking && "animate-spin",
              )}
            />
            <span className="min-w-0 flex-1">检查更新</span>
            <span className="text-xs text-zinc-500">v{APP_VERSION}</span>
          </button>
        </div>
      )}
      <button
        type="button"
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full border bg-zinc-800 text-xs font-semibold text-zinc-100 transition-colors hover:bg-zinc-700",
          open ? "border-zinc-500" : "border-zinc-600",
        )}
        aria-label="打开菜单"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        A
      </button>
    </div>
  );
}
