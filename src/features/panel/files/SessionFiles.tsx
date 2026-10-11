import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Files } from "lucide-react";

import { cn } from "@/lib/utils";
import { usePanel } from "@/features/panel/core/PanelProvider";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { FileList } from "./FileList";
import { filterFiles, setFileFilter, useFileFilter } from "./file-filter";
import { baseName } from "./path";

export function SessionFiles({ sessionId }: { sessionId: string }) {
  const { tabs, activeId, sessionFiles, openDiff } = usePanel();
  const [filter] = useFileFilter();
  const [expanded, setExpanded] = useState(false);
  const toggled = useRef(false);
  const filesRef = useRef(sessionFiles);
  filesRef.current = sessionFiles;
  useEffect(() => {
    toggled.current = false;
    setFileFilter("");
    setExpanded(filesRef.current.length > 0);
  }, [sessionId]);
  useEffect(() => {
    if (!toggled.current && sessionFiles.length > 0) setExpanded(true);
  }, [sessionFiles]);

  const diffOpen = tabs.some((tab) => tab.id === activeId && tab.kind === "diff");
  if (diffOpen) return null;

  const shown = filterFiles(sessionFiles, filter);
  return (
    <aside
      data-session-files
      data-expanded={expanded ? "true" : "false"}
      className={cn(
        "flex h-full shrink-0 flex-col border-l border-zinc-800 bg-zinc-950",
        expanded ? "w-60" : "w-11",
      )}
    >
      <div className={cn("flex items-center gap-1 border-b border-zinc-800", expanded ? "px-2 py-2" : "justify-center py-2")}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? DESKTOP_ZH.collapseSessionFiles : DESKTOP_ZH.expandSessionFiles}
          title={expanded ? DESKTOP_ZH.collapseSessionFiles : DESKTOP_ZH.expandSessionFiles}
          className="flex h-7 w-7 items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
          onClick={() => {
            toggled.current = true;
            setExpanded((value) => !value);
          }}
        >
          {expanded ? <ChevronLeft className="h-4 w-4" /> : <Files className="h-4 w-4" />}
        </button>
        {expanded ? (
          <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{DESKTOP_ZH.sessionFiles}</span>
        ) : null}
      </div>
      {!expanded && sessionFiles.length > 0 ? (
        <span className="pt-1 text-center text-[10px] tabular-nums text-zinc-500">{sessionFiles.length}</span>
      ) : null}
      {expanded ? (
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
