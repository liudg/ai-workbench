import { useCallback, useRef, useState } from "react";
import { Check, Monitor, Moon, RefreshCw, Settings, SlidersHorizontal, Sun } from "lucide-react";

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
    resolvedTheme,
    setTheme,
    toggleTheme,
  } = useAccountMenu();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, rootRef, close);

  const isLight = resolvedTheme === "daylight";
  const nextThemeLabel = isLight ? "切换为极夜精密" : "切换为雾白日光";
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
          className="wb-popover absolute bottom-full right-0 z-30 mb-2 w-56 overflow-hidden p-1"
        >
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-wb-fg-3">外观</p>
          {themeOptions.map((option) => {
            const checked = themePreference === option.id;
            const Icon = option.id === "obsidian" ? Moon : option.id === "daylight" ? Sun : Monitor;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                data-account-theme={option.id}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-wb-fg transition-colors hover:bg-wb-hover",
                  checked && "bg-wb-active/70",
                )}
                onClick={() => setTheme(option.id)}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-wb-fg-3" />
                <span className="min-w-0 flex-1">{option.label}</span>
                {checked ? <Check className="h-3.5 w-3.5 shrink-0 text-wb-accent" /> : null}
              </button>
            );
          })}
          <div className="my-1 h-px bg-wb-border" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-wb-fg transition-colors hover:bg-wb-hover"
            onClick={() => {
              setOpen(false);
              openSettings();
            }}
          >
            <Settings className="h-4 w-4 shrink-0 text-wb-fg-3" />
            <span className="min-w-0 flex-1">设置</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-wb-fg transition-colors hover:bg-wb-hover"
            onClick={() => {
              setOpen(false);
              checkUpdates();
            }}
          >
            <RefreshCw className={cn("h-4 w-4 shrink-0 text-wb-fg-3", checking && "animate-spin")} />
            <span className="min-w-0 flex-1">检查更新</span>
            <span className="text-[11px] text-wb-fg-3">v{APP_VERSION}</span>
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

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          data-theme-toggle=""
          aria-label={nextThemeLabel}
          title={nextThemeLabel}
          onClick={toggleTheme}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
        >
          {isLight ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          aria-label="打开菜单"
          title="设置与更多"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
            open
              ? "bg-wb-active text-wb-fg"
              : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
