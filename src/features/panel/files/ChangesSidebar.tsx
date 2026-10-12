import { useMemo, useState, type ReactNode } from "react";
import { PanelRightClose } from "lucide-react";

import type { FileChange } from "@/features/changes-model/diff-parse";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { FileTreeList } from "./FileTreeList";
import { filterFiles, useFileFilter } from "./file-filter";
import { buildFileTree } from "./file-tree";

export function ChangesSidebar({
  files,
  activePath,
  rowAttr,
  mark,
  width,
  onSelect,
  onHide,
  empty,
}: {
  files: readonly FileChange[];
  activePath: string;
  rowAttr: "data-diff-file" | "data-session-file";
  mark?: "session" | "diff";
  width?: number;
  onSelect: (file: FileChange) => void;
  onHide?: () => void;
  empty: ReactNode;
}) {
  const [filter, setFilter] = useFileFilter();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const shown = useMemo(() => filterFiles(files, filter), [files, filter]);
  const tree = useMemo(() => buildFileTree(shown), [shown]);

  const toggleDir = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <aside
      data-files-sidebar
      data-expanded="true"
      {...(mark === "session" ? { "data-session-files": "" } : {})}
      {...(mark === "diff" ? { "data-diff-files": "" } : {})}
      style={width ? { width, minWidth: width } : undefined}
      className="flex h-full min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-l border-zinc-800 bg-zinc-950"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-800 p-1.5">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={DESKTOP_ZH.filterFiles}
          aria-label={DESKTOP_ZH.filterFiles}
          data-files-filter
          {...(mark === "diff" ? { "data-diff-filter": "" } : {})}
          className="w-full min-w-0 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
        />
        {onHide ? (
          <button
            type="button"
            data-files-toggle
            title={DESKTOP_ZH.filesHideSidebar}
            aria-label={DESKTOP_ZH.filesHideSidebar}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
            onClick={onHide}
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-1">
        {files.length === 0 ? (
          empty
        ) : shown.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">{DESKTOP_ZH.noFileMatch}</p>
        ) : (
          <FileTreeList
            nodes={tree}
            collapsed={collapsed}
            activePath={activePath}
            rowAttr={rowAttr}
            showStats
            onToggle={toggleDir}
            onSelect={onSelect}
          />
        )}
      </div>
    </aside>
  );
}
