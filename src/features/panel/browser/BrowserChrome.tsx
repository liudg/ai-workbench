import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Tooltip } from "@/components/ui/tooltip";
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
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--wb-border)] bg-[var(--wb-canvas)] px-1.5">
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
        <Tooltip
          label={DESKTOP_ZH.browserAnnotateTooltip}
          shortcut={DESKTOP_ZH.browserAnnotateShortcut}
          side="bottom"
          align="start"
        >
          <button
            type="button"
            data-browser-annotate
            aria-pressed={annotating}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              annotating
                ? "bg-[var(--wb-accent-muted)] text-[var(--wb-accent)]"
                : "text-[var(--wb-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]",
            )}
            onClick={onAnnotate}
          >
            <AnnotatePin />
            {DESKTOP_ZH.browserAnnotate}
          </button>
        </Tooltip>
      ) : null}
      <div className="relative min-w-0 flex-1">
        <input
          data-browser-address
          aria-label={DESKTOP_ZH.browserAddressPlaceholder}
          placeholder={DESKTOP_ZH.browserAddressPlaceholder}
          className="h-7 w-full rounded-full border border-[var(--wb-border-strong)] bg-[var(--wb-well)] px-3 text-xs text-[var(--wb-text-strong)] outline-none transition-colors placeholder:text-[var(--wb-faint)] focus:border-[var(--wb-accent)]"
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
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="shrink-0 rounded-md p-1.5 text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)] disabled:text-[var(--wb-faint)] disabled:opacity-45 disabled:hover:bg-transparent"
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
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
