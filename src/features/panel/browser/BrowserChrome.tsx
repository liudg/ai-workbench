import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";

export function BrowserChrome({
  shown,
  draft,
  annotating,
  canBack,
  canForward,
  frameTarget,
  showAnnotate,
  onDraft,
  onFocusAddress,
  onBlurAddress,
  onSubmit,
  onBack,
  onForward,
  onReload,
  onAnnotate,
}: {
  shown: string;
  draft: string | null;
  annotating: boolean;
  canBack: boolean;
  canForward: boolean;
  frameTarget: string;
  showAnnotate: boolean;
  onDraft: (value: string | null) => void;
  onFocusAddress: () => void;
  onBlurAddress: () => void;
  onSubmit: (value: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onAnnotate: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-1.5">
      <ChromeButton label={DESKTOP_ZH.browserBack} disabled={!canBack} onClick={onBack} data-browser-back>
        <ArrowLeft className="h-3.5 w-3.5" />
      </ChromeButton>
      <ChromeButton
        label={DESKTOP_ZH.browserForward}
        disabled={!canForward}
        onClick={onForward}
        data-browser-forward
      >
        <ArrowRight className="h-3.5 w-3.5" />
      </ChromeButton>
      <ChromeButton
        label={DESKTOP_ZH.browserReload}
        disabled={!frameTarget}
        onClick={onReload}
        data-browser-reload
      >
        <RotateCw className="h-3.5 w-3.5" />
      </ChromeButton>
      {showAnnotate ? (
        <div className="group relative shrink-0">
          <button
            type="button"
            data-browser-annotate
            aria-pressed={annotating}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs",
              annotating ? "bg-[#d7e8ff] text-[#2457d6]" : "text-zinc-300 hover:bg-zinc-800",
            )}
            onClick={onAnnotate}
          >
            <AnnotatePin />
            {DESKTOP_ZH.browserAnnotate}
          </button>
          <div
            role="tooltip"
            className="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-max max-w-[260px] items-center gap-1.5 rounded-lg bg-zinc-950 px-2 py-1.5 text-[11px] leading-4 text-white shadow-lg group-hover:flex"
          >
            <span>{DESKTOP_ZH.browserAnnotateTooltip}</span>
            <kbd className="shrink-0 rounded bg-zinc-700 px-1 py-0.5 text-[10px] text-zinc-100">
              {DESKTOP_ZH.browserAnnotateShortcut}
            </kbd>
          </div>
        </div>
      ) : null}
      <div className="relative min-w-0 flex-1">
        <input
          data-browser-address
          aria-label={DESKTOP_ZH.browserAddressPlaceholder}
          placeholder={DESKTOP_ZH.browserAddressPlaceholder}
          className="h-7 w-full rounded-full border border-zinc-700 bg-zinc-950 px-3 text-xs text-zinc-100 outline-none focus:border-zinc-500"
          value={shown}
          spellCheck={false}
          onFocus={onFocusAddress}
          onChange={(event) => onDraft(event.target.value)}
          onBlur={onBlurAddress}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit(draft ?? shown);
            }
          }}
        />
      </div>
    </div>
  );
}

function ChromeButton({
  label,
  disabled,
  onClick,
  children,
  ...rest
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 rounded-md p-1.5 text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600 disabled:hover:bg-transparent"
      {...rest}
    >
      {children}
    </button>
  );
}

function AnnotatePin() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="M8 1.6a3.6 3.6 0 0 0-3.6 3.6c0 2.7 3.6 7.6 3.6 7.6s3.6-4.9 3.6-7.6A3.6 3.6 0 0 0 8 1.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="8" cy="5.2" r="1.15" fill="currentColor" />
    </svg>
  );
}
