import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { filterJumpFiles, jumpFileParts, type JumpFile } from "./jump-files";
import { useAnchoredLayer } from "./useAnchoredLayer";

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
      className="fixed z-[80] w-80 overflow-hidden rounded-xl border border-black/5 bg-white text-zinc-900 shadow-[0_12px_32px_rgba(0,0,0,0.16)]"
      style={{ top: -9999, left: 8 }}
    >
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3">
        <Search className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <input
          ref={inputRef}
          value={query}
          placeholder={DESKTOP_ZH.diffJump}
          aria-label={DESKTOP_ZH.diffJump}
          data-diff-jump-input
          className="h-9 w-full bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400"
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
          <p className="px-3 py-2 text-sm text-zinc-400">{DESKTOP_ZH.noFileChanges}</p>
        ) : matches.length === 0 ? (
          <p className="px-3 py-2 text-sm text-zinc-400">{DESKTOP_ZH.noFileMatch}</p>
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
                  "flex w-full min-w-0 items-baseline gap-3 px-3 py-1.5 text-left",
                  index === activeIndex ? "bg-zinc-100" : "hover:bg-zinc-100",
                )}
                onMouseEnter={() => setCursor(index)}
                onClick={() => onSelect(file.path)}
              >
                <span className="shrink-0 text-sm font-medium text-zinc-900">{parts.name}</span>
                {parts.dir ? <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{parts.dir}</span> : null}
              </button>
            );
          })
        )}
      </div>
    </div>,
    document.body,
  );
}

