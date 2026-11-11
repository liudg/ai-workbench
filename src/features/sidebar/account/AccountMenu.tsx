import { useCallback, useRef, useState } from "react";
import { Command, Monitor, Moon, RefreshCw, Settings, SlidersHorizontal, Sun, SunMoon } from "lucide-react";

import { COMMAND_MENU_COPY, OPEN_COMMAND_MENU } from "@/features/command-menu";
import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import { THEME_OPTIONS, useTheme, type ThemePreference } from "@/shared/theme/theme";
import { FixedMenu } from "../FixedMenu";
import { useAccountMenu } from "./use-account-menu";

function OptionIcon({ id }: { id: ThemePreference }) {
  if (id === "daylight") return <Sun className="h-3.5 w-3.5" />;
  if (id === "system") return <Monitor className="h-3.5 w-3.5" />;
  return <Moon className="h-3.5 w-3.5" />;
}

export function AccountMenu() {
  const { checkUpdates, openSettings, checking } = useAccountMenu();
  const { preference, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const activeOption = THEME_OPTIONS.find((item) => item.id === preference) ?? THEME_OPTIONS[0];

  return (
    <div className="relative">
      <FixedMenu
        open={open}
        anchorRef={anchorRef}
        onClose={close}
        prefer="above"
        label="工作台菜单"
        className="w-60 rounded-2xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] py-1.5 text-[var(--wb-text)] shadow-[var(--wb-float-shadow)]"
      >
        <div className="flex items-center gap-2.5 px-3.5 py-2">
          <SunMoon className="h-4 w-4 shrink-0 text-[var(--wb-muted)]" />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-[var(--wb-text-strong)]">主题</div>
            <div className="truncate text-[11px] text-[var(--wb-muted)]">{activeOption.label}</div>
          </div>
          <div
            role="radiogroup"
            aria-label="主题"
            className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--wb-border)] bg-[var(--wb-well)] p-0.5"
          >
            {THEME_OPTIONS.map((option) => {
              const active = preference === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={option.label}
                  title={option.label}
                  data-theme-option={option.id}
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-[6px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35",
                    active
                      ? "bg-[var(--wb-elev)] text-[var(--wb-text-strong)] shadow-xs ring-1 ring-[var(--wb-border-strong)]"
                      : "text-[var(--wb-faint)] hover:text-[var(--wb-text-strong)]",
                  )}
                  onClick={() => setPreference(option.id)}
                >
                  <OptionIcon id={option.id} />
                </button>
              );
            })}
          </div>
        </div>

        <div className="mx-2 my-1 border-t border-[var(--wb-border)]" />

        <button
          type="button"
          role="menuitem"
          data-open-command-menu
          aria-label={COMMAND_MENU_COPY.open}
          aria-keyshortcuts="Control+K Control+Shift+P"
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm text-[var(--wb-text-strong)] transition-colors hover:bg-[var(--wb-hover)] focus-visible:bg-[var(--wb-hover)] focus-visible:outline-none"
          onClick={() => {
            setOpen(false);
            window.dispatchEvent(new Event(OPEN_COMMAND_MENU));
          }}
        >
          <Command className="h-4 w-4 shrink-0 text-[var(--wb-muted)]" />
          <span className="min-w-0 flex-1">{COMMAND_MENU_COPY.title}</span>
          <span className="shrink-0 font-mono text-xs text-[var(--wb-faint)]">
            {COMMAND_MENU_COPY.shortcutOpen}
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm text-[var(--wb-text-strong)] transition-colors hover:bg-[var(--wb-hover)] focus-visible:bg-[var(--wb-hover)] focus-visible:outline-none"
          onClick={() => {
            setOpen(false);
            openSettings();
          }}
        >
          <Settings className="h-4 w-4 shrink-0 text-[var(--wb-muted)]" />
          <span>设置</span>
        </button>
        <div className="mx-2 my-1 border-t border-[var(--wb-border)]" />
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm text-[var(--wb-text-strong)] transition-colors hover:bg-[var(--wb-hover)] focus-visible:bg-[var(--wb-hover)] focus-visible:outline-none"
          onClick={() => {
            setOpen(false);
            checkUpdates(true);
          }}
        >
          <RefreshCw
            className={cn(
              "h-4 w-4 shrink-0 text-[var(--wb-muted)]",
              checking && "animate-spin",
            )}
          />
          <span className="min-w-0 flex-1">检查更新</span>
          <span className="font-mono text-xs text-[var(--wb-faint)]">v{APP_VERSION}</span>
        </button>
      </FixedMenu>

      <button
        ref={anchorRef}
        type="button"
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35",
          open && "bg-[var(--wb-hover)] text-[var(--wb-text-strong)]",
        )}
        aria-label="打开菜单"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--wb-border-strong)] bg-[var(--wb-chip)] text-[var(--wb-text-strong)]">
          <OptionIcon id={preference} />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--wb-text)]">
          {activeOption.label}
        </span>
        <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-[var(--wb-faint)]" aria-hidden />
      </button>
    </div>
  );
}
