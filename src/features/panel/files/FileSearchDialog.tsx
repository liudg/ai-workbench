import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { FileSearchHit } from "@/lib/ipc";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { cn } from "@/lib/utils";
import { highlightParts, moveSearchCursor } from "./file-search";
import { useProjectFileSearch } from "./useProjectFileSearch";

/** 在工作区里搜索文件名和文件内容。结果来自本机目录，不是占位列表。 */
export function FileSearchDialog({
  projectId,
  onClose,
  onOpen,
}: {
  projectId: string;
  onClose: () => void;
  onOpen: (path: string, line: number | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [mask, setMask] = useState<string>(DESKTOP_ZH.openFilesMaskDefault);
  const [active, setActive] = useState(0);
  const queryRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { hits, truncated, error, loading, done } = useProjectFileSearch(projectId, query, mask);

  useEffect(() => {
    queryRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 pt-16" data-file-search>
      <div
        role="dialog"
        aria-label={DESKTOP_ZH.openFilesSearchTitle}
        onKeyDown={onKeyDown}
        className="w-[min(720px,94vw)] rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm text-zinc-100">{DESKTOP_ZH.openFilesSearchTitle}</h2>
          <button
            type="button"
            data-file-search-esc
            className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-200"
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
          className="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-500"
        />
        <label className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
          <span className="shrink-0">{DESKTOP_ZH.openFilesMask}</span>
          <input
            value={mask}
            onChange={(event) => setMask(event.target.value)}
            aria-label={DESKTOP_ZH.openFilesMask}
            data-file-search-mask
            className="h-7 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-zinc-500"
          />
        </label>
        {query.trim() ? (
          <div className="mt-3 overflow-hidden rounded-lg border border-zinc-800">
            {loading && hits.length === 0 ? (
              <p className="px-3 py-4 text-xs text-zinc-500" data-file-search-pending>
                {DESKTOP_ZH.openFilesSearchPending}
              </p>
            ) : null}
            {error ? (
              <p className="px-3 py-4 text-xs text-red-300" data-file-search-error>
                {error}
              </p>
            ) : null}
            {!loading && !error && hits.length === 0 ? (
              <p className="px-3 py-4 text-xs text-zinc-500" data-file-search-empty>
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
                        "flex w-full min-w-0 items-center gap-3 px-3 py-1.5 text-left",
                        selected ? "bg-zinc-800" : "hover:bg-zinc-800/70",
                      )}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => openHit(hit)}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">
                        <Highlight text={hit.text} query={query} />
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-zinc-500">{where}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {hits.length > 0 ? (
              <div
                className="flex items-center justify-between gap-3 border-t border-zinc-800 px-3 py-2 text-[11px] text-zinc-500"
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
          <mark key={index} data-file-search-mark className="rounded-sm bg-amber-300/35 text-amber-50">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
