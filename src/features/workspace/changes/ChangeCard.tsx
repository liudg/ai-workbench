import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { CODEX_DESKTOP } from "../codex-desktop";
import { usePreview } from "./preview-context";
import {
  baseName,
  canShowMore,
  filesChangedLabel,
  visibleChangeFiles,
  type FileChange,
  type TurnChanges,
} from "./model";

export function ChangeCard({ changes }: { changes: TurnChanges }) {
  const preview = usePreview();
  const [expanded, setExpanded] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const rows = visibleChangeFiles(changes.files, expanded, revealed);
  const more = canShowMore(changes.files.length, revealed) && expanded;

  return (
    <div className="event-in min-w-0 px-6 py-1.5" data-change-card>
      <div className="change-card mx-auto min-w-0 max-w-3xl pl-6">
        <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50">
          <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
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
              <span className="truncate">{filesChangedLabel(changes.files.length)}</span>
            </button>
            <Stat added={changes.added} removed={changes.removed} />
          </div>
          {rows.length > 0 ? (
            <ul className="border-t border-zinc-800/80">
              {rows.map((file) => (
                <li key={file.path}>
                  <FileRow
                    file={file}
                    onOpen={() =>
                      preview.openDiff(
                        `diff:${changes.id}:${file.path}`,
                        baseName(file.path),
                        [file],
                      )
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
                    {CODEX_DESKTOP.showMore}
                  </button>
                </li>
              ) : null}
            </ul>
          ) : null}
          <div className="flex justify-end border-t border-zinc-800/80 px-1.5 py-1">
            <button
              type="button"
              data-view-changes
              className="rounded px-2 py-1 text-xs text-zinc-100 hover:bg-zinc-800"
              onClick={() =>
                preview.openDiff(`diff:${changes.id}`, CODEX_DESKTOP.changesTab, changes.files)
              }
            >
              {CODEX_DESKTOP.viewChanges}
            </button>
          </div>
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
      <span className="w-4 shrink-0 font-mono text-[11px] text-zinc-400">{file.status}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{file.path}</span>
      <Stat added={file.added} removed={file.removed} />
    </button>
  );
}

function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
      <span className="text-emerald-400">+{added}</span>
      <span className="text-red-400">−{removed}</span>
    </span>
  );
}
