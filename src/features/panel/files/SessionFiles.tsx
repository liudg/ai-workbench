import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Files } from "lucide-react";

import { cn } from "@/lib/utils";
import type { FileChange, FileStatus } from "@/features/changes-model/diff-parse";
import { usePanel } from "@/features/panel/core/PanelProvider";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { FileDirectoryGroups } from "./FileDirectoryGroups";
import { baseName, fileStatusTone } from "./path";

export function SessionFiles({ sessionId }: { sessionId: string }) {
  const { sessionFiles, openDiff } = usePanel();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("");
  const toggled = useRef(false);
  const filesRef = useRef(sessionFiles);
  filesRef.current = sessionFiles;
  useEffect(() => {
    toggled.current = false;
    setFilter("");
    setExpanded(filesRef.current.length > 0);
  }, [sessionId]);
  useEffect(() => {
    if (!toggled.current && sessionFiles.length > 0) setExpanded(true);
  }, [sessionFiles]);

  const query = filter.trim().toLowerCase();
  const shown = query
    ? sessionFiles.filter((file) => file.path.toLowerCase().includes(query))
    : sessionFiles;

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
        <>
          <div className="px-2 py-2">
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={DESKTOP_ZH.filterFiles}
              aria-label={DESKTOP_ZH.filterFiles}
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {sessionFiles.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">
                {DESKTOP_ZH.noFileChanges}
              </p>
            ) : shown.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">
                {DESKTOP_ZH.noFileMatch}
              </p>
            ) : (
              <ul>
                <FileDirectoryGroups
                  files={shown}
                  render={(file) => (
                    <li key={file.path}>
                      <SessionFileRow
                        file={file}
                        onOpen={() => openDiff(`session:${file.path}`, baseName(file.path), [file])}
                      />
                    </li>
                  )}
                />
              </ul>
            )}
          </div>
        </>
      ) : null}
    </aside>
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

function SessionFileRow({ file, onOpen }: { file: FileChange; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-session-file={file.path}
      title={file.path}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-zinc-800/80"
      onClick={onOpen}
    >
      <StatusMark status={file.status} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{baseName(file.path)}</span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-emerald-400">+{file.added}</span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-red-400">-{file.removed}</span>
    </button>
  );
}
