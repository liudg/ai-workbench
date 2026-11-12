import { useState } from "react";
import { ChevronRight, File } from "lucide-react";

import { cn } from "@/lib/utils";
import { fileStatusTone, type FileChange, type FileStatus, type TurnChanges } from "@/features/changes-model";
import { usePanelOptional } from "@/features/panel";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { relativeToProject } from "@/shared/path";
import { useChatHost } from "../host";
import { canShowMore, editedFilesLabel, visibleChangeFiles } from "./card-text";

export function ChangeCard({
  changes,
  defaultExpanded = false,
}: {
  changes: TurnChanges;
  /** 已结束的一轮默认收起。进行中的变更卡由调用方展开。 */
  defaultExpanded?: boolean;
}) {
  // 没有右侧面板的宿主只列文件，不给打开差异的入口。
  const preview = usePanelOptional();
  const hostPath = useChatHost().projectPath;
  const root = preview?.projectPath ?? hostPath;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [revealed, setRevealed] = useState(false);
  const multiple = changes.files.length > 1;
  const rows = visibleChangeFiles(changes.files, expanded && multiple, revealed);
  const more = canShowMore(changes.files.length, revealed) && expanded && multiple;
  const title = editedFilesLabel(changes.files);

  return (
    <div className="event-in min-w-0 px-6 py-1.5" data-change-card>
      <div className="change-card min-w-0 pl-6">
        <div className="overflow-hidden rounded-xl border border-wb-border bg-wb-card">
          <div className="flex min-w-0 items-center gap-2 px-3 py-2">
            {multiple ? (
              <button
                type="button"
                aria-expanded={expanded}
                className="flex min-w-0 items-center gap-1.5 text-left text-xs font-medium text-wb-fg transition-colors hover:text-wb-accent-ink"
                onClick={() => setExpanded((value) => !value)}
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 shrink-0 text-wb-fg-3 transition-transform",
                    expanded && "rotate-90",
                  )}
                />
                <File className="h-3.5 w-3.5 shrink-0 text-wb-fg-2" />
                <span data-edited-label className="truncate">
                  {title}
                </span>
              </button>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-wb-fg">
                <File className="h-3.5 w-3.5 shrink-0 text-wb-fg-2" />
                <span data-edited-label className="truncate">
                  {title}
                </span>
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <Stat added={changes.added} removed={changes.removed} />
              {preview ? (
                <button
                  type="button"
                  data-view-changes
                  className="rounded-md px-2 py-1 text-xs font-medium text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
                  onClick={() =>
                    preview.openDiff(`diff:${changes.id}`, DESKTOP_ZH.changesTab, changes.files)
                  }
                >
                  {DESKTOP_ZH.viewChanges}
                </button>
              ) : null}
            </span>
          </div>
          {rows.length > 0 ? (
            <ul className="border-t border-wb-border">
              {rows.map((file) => (
                <li key={file.path}>
                  <FileRow
                    file={file}
                    root={root}
                    onOpen={
                      preview
                        ? () => preview.openDiff(`diff:${changes.id}`, DESKTOP_ZH.changesTab, changes.files, file.path)
                        : undefined
                    }
                  />
                </li>
              ))}
              {more ? (
                <li>
                  <button
                    type="button"
                    data-show-more
                    className="w-full px-3 py-1.5 text-left text-xs text-wb-accent-ink transition-colors hover:bg-wb-hover"
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

function FileRow({ file, onOpen, root }: { file: FileChange; onOpen?: () => void; root: string }) {
  const label = relativeToProject(file.path, root) || file.path;
  const body = (
    <>
      <StatusMark status={file.status} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-wb-fg">{label}</span>
      <Stat added={file.added} removed={file.removed} />
    </>
  );
  if (!onOpen) {
    return (
      <div data-change-file={file.path} title={label} className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-change-file={file.path}
      title={label}
      className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-wb-hover"
      onClick={onOpen}
    >
      {body}
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
        tone === "add" && "text-wb-diff-add-fg",
        tone === "del" && "text-wb-diff-del-fg",
        tone === "neutral" && "text-wb-fg-2",
      )}
    >
      {status}
    </span>
  );
}

function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
      <span className="text-wb-diff-add-fg">+{added}</span>
      <span className="text-wb-diff-del-fg">-{removed}</span>
    </span>
  );
}
