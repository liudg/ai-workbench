import { useEffect, useState } from "react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";

/** 全文搜索浮层。视频没有输入后的结果列表，所以这里不列出结果。 */
export function FileSearchDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [mask, setMask] = useState<string>(DESKTOP_ZH.openFilesMaskDefault);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center bg-black/45 pt-14" data-file-search>
      <div
        role="dialog"
        aria-label={DESKTOP_ZH.openFilesSearchTitle}
        className="w-[min(440px,92%)] rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-xl"
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
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={DESKTOP_ZH.openFilesSearchPlaceholder}
          aria-label={DESKTOP_ZH.openFilesSearchPlaceholder}
          data-file-search-query
          className="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-500"
        />
        <label className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
          <span>{DESKTOP_ZH.openFilesMask}</span>
          <input
            value={mask}
            onChange={(event) => setMask(event.target.value)}
            aria-label={DESKTOP_ZH.openFilesMask}
            data-file-search-mask
            className="h-7 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-zinc-500"
          />
        </label>
      </div>
    </div>
  );
}
