import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { filterJumpFiles, jumpFileParts, type JumpFile } from "./jump-files";
import { useAnchoredLayer } from "../core/useAnchoredLayer";

export function JumpPopover({
  anchorRef,
  files,
  activePath,
  onSelect,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  files: readonly JumpFile[];
  activePath: string;
  onSelect: (path: string) => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(() => Math.max(0, files.findIndex((file) => file.path === activePath)));
  const matches = filterJumpFiles(files, query);
  const activeIndex = matches.length === 0 ? 0 : Math.min(Math.max(cursor, 0), matches.length - 1);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useAnchoredLayer(true, anchorRef, popoverRef, `${query}:${matches.length}`);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={DESKTOP_ZH.diffJump}
      data-diff-jump-popover
      className="fixed z-[80] w-80 overflow-hidden rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] text-[var(--wb-text)] shadow-[var(--wb-float-shadow)]"
    >
      <div className="flex items-center gap-2 border-b border-[var(--wb-border)] px-3">
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--wb-muted)]" />
        <input
          ref={inputRef}
          value={query}
          placeholder={DESKTOP_ZH.diffJump}
          aria-label={DESKTOP_ZH.diffJump}
          data-diff-jump-input
          className="h-9 w-full bg-transparent text-sm text-[var(--wb-text-strong)] outline-none placeholder:text-[var(--wb-faint)]"
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (matches.length === 0) return;
              setCursor((value) => Math.min(matches.length - 1, Math.max(0, value) + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const file = matches[activeIndex];
              if (file) onSelect(file.path);
            }
          }}
        />
      </div>
      <div className="max-h-72 overflow-y-auto py-1" role="listbox" aria-label={DESKTOP_ZH.diffJump}>
        {files.length === 0 ? (
          <p className="px-3 py-2 text-sm text-[var(--wb-muted)]">{DESKTOP_ZH.noFileChanges}</p>
        ) : matches.length === 0 ? (
          <p className="px-3 py-2 text-sm text-[var(--wb-muted)]">{DESKTOP_ZH.noFileMatch}</p>
        ) : (
          matches.map((file, index) => {
            const parts = jumpFileParts(file.path);
            return (
              <button
                key={file.path}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                data-diff-jump-file={file.path}
                data-diff-jump-current={file.path === activePath ? "true" : "false"}
                className={cn(
                  "flex w-full min-w-0 items-baseline gap-3 px-3 py-1.5 text-left transition-colors",
                  index === activeIndex ? "bg-[var(--wb-hover-strong)]" : "hover:bg-[var(--wb-hover)]",
                )}
                onMouseEnter={() => setCursor(index)}
                onClick={() => onSelect(file.path)}
              >
                <span className="shrink-0 text-sm font-medium text-[var(--wb-text-strong)]">{parts.name}</span>
                {parts.dir ? <span className="min-w-0 flex-1 truncate text-xs text-[var(--wb-muted)]">{parts.dir}</span> : null}
              </button>
            );
          })
        )}
      </div>
    </div>,
    document.body,
  );
}

