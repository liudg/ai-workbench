import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { FileSearchHit } from "@/lib/ipc";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { cn } from "@/lib/utils";
import { usePanelOptional } from "../core/PanelProvider";
import { useDismissLayer } from "../core/useDismissLayer";
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
  const [mask, setMask] = useState<string>(DESKTOP_ZH.openFilesMaskDefault);
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

  const openHit = (hit: FileSearchHit | undefined) => {
    if (!hit) return;
    onOpen(hit.path, hit.line);
    onClose();
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const key = event.key;
      setActive((current) => moveSearchCursor(current, hits.length, key));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      openHit(hits[active]);
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-[var(--wb-backdrop)] pt-16 backdrop-blur-[2px]"
      data-file-search
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={DESKTOP_ZH.openFilesSearchTitle}
        onKeyDown={onKeyDown}
        className="w-[min(720px,94vw)] rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] p-4 shadow-[var(--wb-float-shadow)]"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-[var(--wb-text-strong)]">{DESKTOP_ZH.openFilesSearchTitle}</h2>
          <button
            type="button"
            data-file-search-esc
            className="rounded-md border border-[var(--wb-border)] bg-[var(--wb-chip)] px-1.5 py-0.5 text-[11px] text-[var(--wb-muted)] hover:bg-[var(--wb-chip-hover)] hover:text-[var(--wb-text-strong)]"
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
          className="h-9 w-full rounded-lg border border-[var(--wb-border-strong)] bg-[var(--wb-well)] px-3 text-sm text-[var(--wb-text-strong)] outline-none placeholder:text-[var(--wb-faint)] focus:border-[var(--wb-accent)]"
        />
        <label className="mt-3 flex items-center gap-2 text-xs text-[var(--wb-muted)]">
          <span className="shrink-0">{DESKTOP_ZH.openFilesMask}</span>
          <input
            value={mask}
            onChange={(event) => setMask(event.target.value)}
            aria-label={DESKTOP_ZH.openFilesMask}
            data-file-search-mask
            className="h-7 min-w-0 flex-1 rounded-md border border-[var(--wb-border-strong)] bg-[var(--wb-well)] px-2 text-xs text-[var(--wb-text-strong)] outline-none focus:border-[var(--wb-accent)]"
          />
        </label>
        {query.trim() ? (
          <div className="mt-3 overflow-hidden rounded-lg border border-[var(--wb-border)] bg-[var(--wb-well)]">
            {loading && hits.length === 0 ? (
              <p className="px-3 py-4 text-xs text-[var(--wb-muted)]" data-file-search-pending>
                {DESKTOP_ZH.openFilesSearchPending}
              </p>
            ) : null}
            {error ? (
              <p className="px-3 py-4 text-xs text-[var(--wb-danger-text)]" data-file-search-error>
                {error}
              </p>
            ) : null}
            {!loading && !error && hits.length === 0 ? (
              <p className="px-3 py-4 text-xs text-[var(--wb-muted)]" data-file-search-empty>
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
                  const selected = index === active;
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
                        selected ? "bg-[var(--wb-chip)]" : "hover:bg-[var(--wb-hover)]",
                      )}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => openHit(hit)}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--wb-text-strong)]">
                        <Highlight text={hit.text} query={query} />
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-[var(--wb-muted)]">{where}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {hits.length > 0 ? (
              <div
                className="flex items-center justify-between gap-3 border-t border-[var(--wb-border)] px-3 py-2 text-[11px] text-[var(--wb-muted)]"
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
          <mark key={index} data-file-search-mark className="rounded-[2px] bg-[var(--wb-find-hit-bg)] px-0.5 text-[var(--wb-find-hit-fg)]">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
