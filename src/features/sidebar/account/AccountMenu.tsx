import { useCallback, useRef, useState } from "react";
import { Ellipsis, Monitor, Moon, RefreshCw, Settings, Sun } from "lucide-react";

import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import { useDismiss } from "../use-dismiss";
import { useAccountMenu } from "./use-account-menu";

export function AccountMenu() {
  const {
    checkUpdates,
    openSettings,
    checking,
    readyCount,
    themePreference,
    themeOptions,
    setTheme,
  } = useAccountMenu();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, rootRef, close);

  const statusLabel =
    readyCount === null
      ? "正在检测 Agent"
      : readyCount > 0
        ? `${readyCount} 个 Agent 就绪`
        : "配置本地 Agent";

  return (
    <div ref={rootRef} className="relative flex items-center justify-between gap-1.5">
      {open && (
        <div
          role="menu"
          aria-label="工作台菜单"
          className="wb-popover absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden p-1.5"
        >
          <div
            role="radiogroup"
            aria-label="外观"
            className="grid grid-cols-3 gap-0.5 rounded-lg border border-wb-border bg-[var(--wb-seg-track)] p-0.5"
          >
            {themeOptions.map((option) => {
              const checked = themePreference === option.id;
              const Icon = option.id === "obsidian" ? Moon : option.id === "daylight" ? Sun : Monitor;
              const shortLabel = option.id === "system" ? "系统" : option.label;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  data-account-theme={option.id}
                  className={cn(
                    "flex h-7 items-center justify-center gap-1 rounded-md text-xs transition-all",
                    checked
                      ? "bg-[var(--wb-seg-thumb)] font-medium text-wb-fg shadow-[var(--wb-seg-thumb-shadow)]"
                      : "text-wb-fg-3 hover:text-wb-fg-2",
                  )}
                  onClick={() => setTheme(option.id)}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                  <span>{shortLabel}</span>
                </button>
              );
            })}
          </div>
          <div className="my-1.5 h-px bg-wb-border" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-wb-fg transition-colors hover:bg-wb-hover"
            onClick={() => {
              setOpen(false);
              openSettings();
            }}
          >
            <Settings className="h-3.5 w-3.5 shrink-0 text-wb-fg-3" strokeWidth={1.8} />
            <span className="min-w-0 flex-1">设置</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-wb-fg transition-colors hover:bg-wb-hover"
            onClick={() => {
              setOpen(false);
              checkUpdates();
            }}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5 shrink-0 text-wb-fg-3", checking && "animate-spin")}
              strokeWidth={1.8}
            />
            <span className="min-w-0 flex-1">检查更新</span>
            <span className="text-[11px] tabular-nums text-wb-fg-3">v{APP_VERSION}</span>
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={openSettings}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
        title="查看 Agent 与连接状态"
      >
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            readyCount === null
              ? "animate-pulse bg-wb-fg-3"
              : readyCount > 0
                ? "bg-wb-ok"
                : "bg-wb-warn",
          )}
        />
        <span className="min-w-0 truncate">{statusLabel}</span>
      </button>

      <button
        type="button"
        aria-label="打开菜单"
        title="外观与设置"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
          open ? "bg-wb-active text-wb-fg" : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
        )}
      >
        <Ellipsis className="h-4 w-4" strokeWidth={1.8} />
      </button>
    </div>
  );
}
