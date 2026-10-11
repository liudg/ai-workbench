import { useState } from "react";
import { ChevronRight, File } from "lucide-react";

import { cn } from "@/lib/utils";
import type { FileChange, FileStatus, TurnChanges } from "@/features/changes-model/diff-parse";
import { usePanel } from "@/features/panel/core/PanelProvider";
import { baseName, fileStatusTone } from "@/features/panel/files/path";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { canShowMore, editedFilesLabel, visibleChangeFiles } from "./card-text";

export function ChangeCard({ changes }: { changes: TurnChanges }) {
  const preview = usePanel();
  const [expanded, setExpanded] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const multiple = changes.files.length > 1;
  const rows = visibleChangeFiles(changes.files, expanded && multiple, revealed);
  const more = canShowMore(changes.files.length, revealed) && expanded && multiple;
  const title = editedFilesLabel(changes.files);

  return (
    <div className="event-in min-w-0 px-6 py-1.5" data-change-card>
      <div className="change-card mx-auto min-w-0 max-w-3xl pl-6">
        <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50">
          <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
            {multiple ? (
              <button
                type="button"
                aria-expanded={expanded}
                className="flex min-w-0 items-center gap-1.5 text-left text-xs text-zinc-100"
                onClick={() => setExpanded((value) => !value)}
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 shrink-0 text-zinc-500 transition-transform",
                    expanded && "rotate-90",
                  )}
                />
                <File className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                <span data-edited-label className="truncate">
                  {title}
                </span>
              </button>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-100">
                <File className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                <span data-edited-label className="truncate">
                  {title}
                </span>
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <Stat added={changes.added} removed={changes.removed} />
              <button
                type="button"
                data-view-changes
                className="rounded px-2 py-1 text-xs text-zinc-100 hover:bg-zinc-800"
                onClick={() =>
                  preview.openDiff(`diff:${changes.id}`, DESKTOP_ZH.changesTab, changes.files)
                }
              >
                {DESKTOP_ZH.viewChanges}
              </button>
            </span>
          </div>
          {rows.length > 0 ? (
            <ul className="border-t border-zinc-800/80">
              {rows.map((file) => (
                <li key={file.path}>
                  <FileRow
                    file={file}
                    onOpen={() =>
                      preview.openDiff(`diff:${changes.id}:${file.path}`, baseName(file.path), [file])
                    }
                  />
                </li>
              ))}
              {more ? (
                <li>
                  <button
                    type="button"
                    data-show-more
                    className="w-full px-2.5 py-1.5 text-left text-xs text-sky-300 hover:bg-zinc-800/60 hover:text-sky-200"
                    onClick={() => setRevealed(true)}
                  >
                    {DESKTOP_ZH.showMore}
                  </button>
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FileRow({ file, onOpen }: { file: FileChange; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-change-file={file.path}
      title={file.path}
      className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left hover:bg-zinc-800/70"
      onClick={onOpen}
    >
      <StatusMark status={file.status} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{file.path}</span>
      <Stat added={file.added} removed={file.removed} />
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

function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
      <span className="text-emerald-400">+{added}</span>
      <span className="text-red-400">-{removed}</span>
    </span>
  );
}
