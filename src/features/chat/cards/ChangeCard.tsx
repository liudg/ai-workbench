import { useState } from "react";
import { ChevronRight, File } from "lucide-react";

import { cn } from "@/lib/utils";
import type { FileChange, FileStatus, TurnChanges } from "@/features/changes-model/diff-parse";
import { usePanel } from "@/features/panel/core/PanelProvider";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { fileStatusTone } from "@/features/changes-model/status-tone";
import { baseName, relativeToProject } from "@/shared/path";
import { canShowMore, editedFilesLabel, visibleChangeFiles } from "./card-text";

export function ChangeCard({
  changes,
  defaultExpanded = false,
}: {
  changes: TurnChanges;
  /** 已结束的一轮默认收起。进行中的变更卡由调用方展开。 */
  defaultExpanded?: boolean;
}) {
  const preview = usePanel();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [revealed, setRevealed] = useState(false);
  const multiple = changes.files.length > 1;
  const rows = visibleChangeFiles(changes.files, expanded && multiple, revealed);
  const more = canShowMore(changes.files.length, revealed) && expanded && multiple;
  const title = editedFilesLabel(changes.files);

  return (
    <div className="event-in min-w-0 px-6 py-1.5" data-change-card>
      <div className="change-card min-w-0 pl-6">
        <div className="overflow-hidden rounded-xl border border-[var(--wb-border)] bg-[var(--wb-card)]">
          <div className="flex min-w-0 items-center gap-2 px-3 py-1.5">
            {multiple ? (
              <button
                type="button"
                aria-expanded={expanded}
                className="flex min-w-0 items-center gap-1.5 text-left text-xs font-medium text-[var(--wb-text-strong)]"
                onClick={() => setExpanded((value) => !value)}
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 shrink-0 text-[var(--wb-faint)] transition-transform",
                    expanded && "rotate-90",
                  )}
                />
                <File className="h-3.5 w-3.5 shrink-0 text-[var(--wb-muted)]" />
                <span data-edited-label className="truncate">
                  {title}
                </span>
              </button>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-[var(--wb-text-strong)]">
                <File className="h-3.5 w-3.5 shrink-0 text-[var(--wb-muted)]" />
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
                className="rounded-md px-2 py-1 text-xs font-medium text-[var(--wb-text)] transition-colors hover:bg-[var(--wb-hover-strong)] hover:text-[var(--wb-text-strong)]"
                onClick={() =>
                  preview.openDiff(`diff:${changes.id}`, DESKTOP_ZH.changesTab, changes.files)
                }
              >
                {DESKTOP_ZH.viewChanges}
              </button>
            </span>
          </div>
          {rows.length > 0 ? (
            <ul className="border-t border-[var(--wb-border)]">
              {rows.map((file) => (
                <li key={file.path}>
                  <FileRow
                    file={file}
                    root={preview.projectPath}
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
                    className="w-full px-3 py-1.5 text-left text-xs text-[var(--wb-link)] transition-colors hover:bg-[var(--wb-card-hover)]"
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

function FileRow({ file, onOpen, root }: { file: FileChange; onOpen: () => void; root: string }) {
  const label = relativeToProject(file.path, root) || file.path;
  return (
    <button
      type="button"
      data-change-file={file.path}
      title={label}
      className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--wb-card-hover)]"
      onClick={onOpen}
    >
      <StatusMark status={file.status} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--wb-text)]">{label}</span>
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
        tone === "add" && "text-[var(--wb-add-stat)]",
        tone === "mod" && "text-[var(--wb-warn-strong)]",
        tone === "del" && "text-[var(--wb-del-stat)]",
        tone === "neutral" && "text-[var(--wb-muted)]",
      )}
    >
      {status}
    </span>
  );
}

function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
      <span className="text-[var(--wb-add-stat)]">+{added}</span>
      <span className="text-[var(--wb-del-stat)]">-{removed}</span>
    </span>
  );
}
