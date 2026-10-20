import { useCallback, useRef, useState } from "react";
import { Command, RefreshCw, Settings } from "lucide-react";

import { COMMAND_MENU_COPY, OPEN_COMMAND_MENU } from "@/features/command-menu";
import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import { useDismiss } from "../use-dismiss";
import { useAccountMenu } from "./use-account-menu";

export function AccountMenu() {
  const { checkUpdates, openSettings, checking } = useAccountMenu();
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
            data-open-command-menu
            aria-label={COMMAND_MENU_COPY.open}
            aria-keyshortcuts="Control+K Control+Shift+P"
            className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm text-zinc-100 transition-colors hover:bg-zinc-800/90"
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new Event(OPEN_COMMAND_MENU));
            }}
          >
            <Command className="h-4 w-4 shrink-0 text-zinc-400" />
            <span className="min-w-0 flex-1">{COMMAND_MENU_COPY.title}</span>
            <span className="shrink-0 text-xs text-zinc-500">{COMMAND_MENU_COPY.shortcutOpen}</span>
          </button>
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
          "flex h-8 w-8 items-center justify-center rounded-full border bg-[#2a2a2a] text-xs font-semibold text-[#e8e8e8] transition-colors hover:bg-[#333]",
          open ? "border-[#666]" : "border-[#3a3a3a]",
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
