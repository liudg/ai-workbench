import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { CODEX_DESKTOP } from "../codex-desktop";
import {
  baseName,
  diffScopeMenu,
  foldDiffLines,
  unmodifiedLinesLabel,
  type DiffFoldRow,
  type FileChange,
} from "./model";

const SCOPES = diffScopeMenu();

export function DiffView({ files }: { files: FileChange[] }) {
  const [scope, setScope] = useState("turn");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const current = SCOPES.find((item) => item.id === scope) ?? SCOPES[0];
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const query = filter.trim().toLowerCase();
  const shown = query
    ? files.filter((file) => file.path.toLowerCase().includes(query))
    : files;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  if (files.length === 0) {
    return <p className="px-4 py-6 text-sm text-zinc-500">{CODEX_DESKTOP.noFileChanges}</p>;
  }

  return (
    <div className="flex h-full min-h-0 min-w-0" data-diff-view>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-2">
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              data-diff-scope
              aria-expanded={open}
              aria-haspopup="menu"
              className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-1 text-xs text-zinc-100"
              onClick={() => setOpen((value) => !value)}
            >
              {current.label}
              <ChevronDown className="h-3 w-3 text-zinc-400" />
            </button>
            {open ? (
              <div
                role="menu"
                data-diff-scope-menu
                className="absolute left-0 top-full z-20 mt-1 w-40 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
              >
                {SCOPES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    data-diff-scope-item={item.id}
                    data-submenu={item.submenu ? "true" : "false"}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-100 hover:bg-zinc-800"
                    onClick={() => {
                      if (item.submenu) return;
                      setScope(item.id);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1">{item.label}</span>
                    {scope === item.id ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                    {item.submenu ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <span className="font-mono text-xs text-emerald-400">+{added}</span>
          <span className="font-mono text-xs text-red-400">-{removed}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {shown.map((file) => (
            <FileSection key={file.path} file={file} />
          ))}
        </div>
      </div>
      <aside className="flex w-52 shrink-0 flex-col border-l border-zinc-800">
        <div className="p-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={CODEX_DESKTOP.filterFiles}
            aria-label={CODEX_DESKTOP.filterFiles}
            data-diff-filter
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
          />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {shown.map((file) => (
            <li key={file.path}>
              <div
                data-diff-file={file.path}
                className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">
                  {baseName(file.path)}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-emerald-400">+{file.added}</span>
                <span className="shrink-0 font-mono text-[11px] text-red-400">-{file.removed}</span>
              </div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

function FileSection({ file }: { file: FileChange }) {
  const rows = foldDiffLines(file.diff);
  return (
    <section className="border-b border-zinc-800" data-diff-file-body={file.path}>
      <header className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-zinc-300"># {baseName(file.path)}</span>
        <span className="font-mono text-emerald-400">+{file.added}</span>
        <span className="font-mono text-red-400">-{file.removed}</span>
      </header>
      {rows.length === 0 ? (
        <p className="px-3 py-2 text-xs text-zinc-500">没有可显示的差异文本。</p>
      ) : (
        <div className="pb-2 font-mono text-xs leading-5">
          {rows.map((row, index) => (
            <DiffRowView key={index} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

function DiffRowView({ row }: { row: DiffFoldRow }) {
  if (row.kind === "collapse") {
    return (
      <div data-unmodified-lines={row.count} className="mx-3 my-1 rounded bg-zinc-800 px-3 py-1 text-zinc-400">
        {unmodifiedLinesLabel(row.count)}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex min-w-0",
        row.tone === "add" && "bg-emerald-500/15 text-emerald-200",
        row.tone === "del" && "bg-red-500/15 text-red-200",
        row.tone === "context" && "text-zinc-300",
        row.tone === "meta" && "text-zinc-500",
      )}
    >
      <span className="w-10 shrink-0 select-none px-2 text-right text-zinc-500">{row.lineNo ?? ""}</span>
      <span className="min-w-0 flex-1 whitespace-pre px-2">{row.text.length > 0 ? row.text : " "}</span>
    </div>
  );
}
