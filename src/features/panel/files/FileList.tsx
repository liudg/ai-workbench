import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { FileChange, FileStatus } from "@/features/changes-model/diff-parse";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { FileDirectoryGroups } from "./FileDirectoryGroups";
import { useFileFilter } from "./file-filter";
import { baseName, fileStatusTone } from "./path";

export function FileList({
  files,
  activePath,
  onSelect,
  rowAttr,
  filterAttr,
  empty,
}: {
  files: readonly FileChange[];
  activePath: string;
  onSelect: (file: FileChange) => void;
  rowAttr: "data-diff-file" | "data-session-file";
  filterAttr?: "data-diff-filter";
  empty: ReactNode;
}) {
  const [filter, setFilter] = useFileFilter();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 p-1.5">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={DESKTOP_ZH.filterFiles}
          aria-label={DESKTOP_ZH.filterFiles}
          {...(filterAttr ? { [filterAttr]: "" } : {})}
          className="w-full min-w-0 truncate rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pb-2">
        {files.length === 0 ? (
          empty
        ) : (
          <ul>
            <FileDirectoryGroups
              files={files}
              render={(file) => (
                <li key={file.path}>
                  <FileRow
                    file={file}
                    active={file.path === activePath}
                    rowAttr={rowAttr}
                    onSelect={onSelect}
                  />
                </li>
              )}
            />
          </ul>
        )}
      </div>
    </div>
  );
}

function FileRow({
  file,
  active,
  rowAttr,
  onSelect,
}: {
  file: FileChange;
  active: boolean;
  rowAttr: "data-diff-file" | "data-session-file";
  onSelect: (file: FileChange) => void;
}) {
  return (
    <button
      type="button"
      {...{ [rowAttr]: file.path }}
      title={file.path}
      className={cn(
        "flex w-full min-w-0 flex-nowrap items-center gap-1 rounded-md px-1 py-1.5 text-left",
        active ? "bg-zinc-800" : "hover:bg-zinc-800/80",
      )}
      onClick={() => onSelect(file)}
    >
      <StatusMark status={file.status} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{baseName(file.path)}</span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-emerald-400">+{file.added}</span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-red-400">-{file.removed}</span>
    </button>
  );
}

function StatusMark({ status }: { status: FileStatus }) {
  const tone = fileStatusTone(status);
  return (
    <span
      data-file-status={status}
      className={cn(
        "w-4 shrink-0 font-mono text-[11px]",
        tone === "add" && "text-emerald-400",
        tone === "del" && "text-red-400",
        tone === "neutral" && "text-zinc-400",
      )}
    >
      {status}
    </span>
  );
}
