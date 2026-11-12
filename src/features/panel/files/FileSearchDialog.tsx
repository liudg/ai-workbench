import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { FileSearchHit } from "@/types";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { cn } from "@/lib/utils";
import { usePanelOptional } from "../core/PanelProvider";
import { useDismissLayer } from "@/shared/menu/useDismissLayer";
import { highlightParts, moveSearchCursor } from "./file-search";
import { useProjectFileSearch } from "./useProjectFileSearch";

/** 在工作区里搜索文件名和文件内容。结果来自本机目录，不是占位列表。 */
export function FileSearchDialog({
  projectId,
  sessionId,
  onClose,
  onOpen,
}: {
  projectId: string;
  sessionId?: string;
  onClose: () => void;
  onOpen: (path: string, line: number | null) => void;
}) {
  const panelSessionId = usePanelOptional()?.sessionId;
  const [query, setQuery] = useState("");
  const [mask, setMask] = useState("");
  const [active, setActive] = useState(0);
  const queryRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { hits, truncated, error, loading, done } = useProjectFileSearch(
    projectId,
    query,
    mask,
    sessionId || panelSessionId,
  );

  useEffect(() => {
    queryRef.current?.focus();
  }, []);

  useDismissLayer(true, onClose);

  useEffect(() => {
    setActive(0);
  }, [query, mask]);

  useEffect(() => {
    listRef.current
      ?.querySelector("[data-file-search-active='true']")
      ?.scrollIntoView({ block: "nearest" });
  }, [active, hits]);

  const selectedIndex = hits.length === 0 ? 0 : Math.min(active, hits.length - 1);

  const openHit = (hit: FileSearchHit | undefined) => {
    if (!hit) return;
    onOpen(hit.path, hit.line);
    onClose();
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const key = event.key;
      setActive((current) => moveSearchCursor(Math.min(current, Math.max(hits.length - 1, 0)), hits.length, key));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      openHit(hits[selectedIndex]);
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-wb-backdrop pt-16 backdrop-blur-[2px]"
      data-file-search
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={DESKTOP_ZH.openFilesSearchTitle}
        onKeyDown={onKeyDown}
        className="wb-popover w-[min(720px,94vw)] rounded-2xl p-4"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-wb-fg">{DESKTOP_ZH.openFilesSearchTitle}</h2>
          <button
            type="button"
            data-file-search-esc
            className="rounded-md border border-wb-border bg-wb-elev px-1.5 py-0.5 text-[11px] text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
            onClick={onClose}
          >
            Esc
          </button>
        </div>
        <input
          ref={queryRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={DESKTOP_ZH.openFilesSearchPlaceholder}
          aria-label={DESKTOP_ZH.openFilesSearchPlaceholder}
          data-file-search-query
          className="h-9 w-full rounded-lg border border-wb-border-strong bg-wb-input px-3 text-sm text-wb-fg outline-none transition-colors placeholder:text-wb-dim focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft"
        />
        <label className="mt-3 flex items-center gap-2 text-xs text-wb-fg-2">
          <span className="shrink-0">{DESKTOP_ZH.openFilesMask}</span>
          <input
            value={mask}
            onChange={(event) => setMask(event.target.value)}
            placeholder={DESKTOP_ZH.openFilesMaskPlaceholder}
            aria-label={DESKTOP_ZH.openFilesMask}
            data-file-search-mask
            className="h-7 min-w-0 flex-1 rounded-lg border border-wb-border-strong bg-wb-input px-2.5 text-xs text-wb-fg outline-none transition-colors placeholder:text-wb-dim focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft"
          />
        </label>
        {query.trim() ? (
          <div className="mt-3 overflow-hidden rounded-xl border border-wb-border bg-wb-card">
            {loading && hits.length === 0 ? (
              <p className="px-3 py-4 text-xs text-wb-fg-3" data-file-search-pending>
                {DESKTOP_ZH.openFilesSearchPending}
              </p>
            ) : null}
            {error ? (
              <p className="px-3 py-4 text-xs text-wb-danger" data-file-search-error>
                {error}
              </p>
            ) : null}
            {!loading && !error && hits.length === 0 ? (
              <p className="px-3 py-4 text-xs text-wb-fg-3" data-file-search-empty>
                {DESKTOP_ZH.openFilesSearchEmpty}
              </p>
            ) : null}
            {hits.length > 0 ? (
              <div
                ref={listRef}
                role="listbox"
                aria-label={DESKTOP_ZH.openFilesSearchTitle}
                className="max-h-[min(360px,50vh)] overflow-y-auto"
              >
                {hits.map((hit, index) => {
                  const where = hit.line ? `${hit.path}:${hit.line}` : hit.path;
                  const selected = index === selectedIndex;
                  return (
                    <button
                      key={`${hit.kind}:${hit.path}:${hit.line ?? ""}:${index}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      data-file-search-active={selected ? "true" : "false"}
                      data-file-search-hit={hit.path}
                      data-file-search-line={hit.line ?? ""}
                      data-file-search-kind={hit.kind}
                      className={cn(
                        "flex w-full min-w-0 items-center gap-3 px-3 py-1.5 text-left transition-colors",
                        selected ? "bg-wb-active" : "hover:bg-wb-hover",
                      )}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => openHit(hit)}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-wb-fg">
                        <Highlight text={hit.text} query={query} />
                      </span>
                      <span
                        title={where}
                        className="max-w-[42%] shrink-0 truncate font-mono text-[11px] tabular-nums text-wb-fg-3"
                      >
                        {where}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {hits.length > 0 ? (
              <div
                className="flex items-center justify-between gap-3 border-t border-wb-border px-3 py-2 text-[11px] text-wb-fg-3"
                data-file-search-footer
              >
                <span data-file-search-cap>
                  {loading && !done ? DESKTOP_ZH.openFilesSearchPending : truncated ? DESKTOP_ZH.openFilesSearchCap : ""}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span>↑↓ {DESKTOP_ZH.openFilesSearchSwitch}</span>
                  <span>Enter {DESKTOP_ZH.openFilesSearchEnter}</span>
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.hit ? (
          <mark key={index} data-file-search-mark className="rounded-xs bg-wb-accent-soft px-0.5 text-wb-accent-ink">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
