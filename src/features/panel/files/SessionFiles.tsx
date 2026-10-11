import { useEffect } from "react";
import { ChevronLeft, Files } from "lucide-react";

import { cn } from "@/lib/utils";
import { usePanel } from "@/features/panel/core/PanelProvider";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { FileList } from "./FileList";
import { filterFiles, setFileFilter, useFileFilter } from "./file-filter";
import { baseName } from "./path";

export function SessionFiles({ width }: { width: number }) {
  const { sessionId, sessionFiles, openDiff, filesExpanded, toggleFiles } = usePanel();
  const [filter] = useFileFilter();
  useEffect(() => {
    setFileFilter("");
  }, [sessionId]);

  const shown = filterFiles(sessionFiles, filter);
  return (
    <aside
      data-session-files
      data-expanded={filesExpanded ? "true" : "false"}
      style={{ width }}
      className="flex h-full shrink-0 flex-col overflow-hidden border-l border-zinc-800 bg-zinc-950"
    >
      <div className={cn("flex items-center gap-1 border-b border-zinc-800", filesExpanded ? "px-2 py-2" : "justify-center py-2")}>
        <button
          type="button"
          aria-expanded={filesExpanded}
          aria-label={filesExpanded ? DESKTOP_ZH.collapseSessionFiles : DESKTOP_ZH.expandSessionFiles}
          title={filesExpanded ? DESKTOP_ZH.collapseSessionFiles : DESKTOP_ZH.expandSessionFiles}
          className="flex h-7 w-7 items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
          onClick={toggleFiles}
        >
          {filesExpanded ? <ChevronLeft className="h-4 w-4" /> : <Files className="h-4 w-4" />}
        </button>
        {filesExpanded ? (
          <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{DESKTOP_ZH.sessionFiles}</span>
        ) : null}
      </div>
      {!filesExpanded && sessionFiles.length > 0 ? (
        <span className="pt-1 text-center text-[10px] tabular-nums text-zinc-500">{sessionFiles.length}</span>
      ) : null}
      {filesExpanded ? (
        <FileList
          files={shown}
          activePath=""
          rowAttr="data-session-file"
          onSelect={(file) => openDiff(`session:${file.path}`, baseName(file.path), [file])}
          empty={
            sessionFiles.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">{DESKTOP_ZH.noFileChanges}</p>
            ) : (
              <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">{DESKTOP_ZH.noFileMatch}</p>
            )
          }
        />
      ) : null}
    </aside>
  );
}
