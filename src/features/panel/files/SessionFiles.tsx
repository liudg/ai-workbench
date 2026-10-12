import { useEffect, useState } from "react";
import { Files } from "lucide-react";

import { backend } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { usePanel } from "@/features/panel/core/PanelProvider";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { ChangesSidebar } from "./ChangesSidebar";
import { setFileFilter } from "./file-filter";
import { baseName } from "./path";

export function SessionFiles({ width }: { width: number }) {
  const {
    sessionId,
    projectId,
    sessionFiles,
    openDiff,
    openHref,
    filesExpanded,
    toggleFiles,
    toggleFilesSidebar,
  } = usePanel();
  const [activePath, setActivePath] = useState("");
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    setFileFilter("");
    setActivePath("");
  }, [sessionId]);

  if (!filesExpanded) {
    return (
      <aside
        data-session-files
        data-expanded="false"
        style={{ width }}
        className="flex h-full shrink-0 flex-col overflow-hidden border-l border-zinc-800 bg-zinc-950"
      >
        <div className={cn("flex items-center justify-center gap-1 border-b border-zinc-800 py-2")}>
          <button
            type="button"
            aria-expanded={false}
            aria-label={DESKTOP_ZH.expandSessionFiles}
            title={DESKTOP_ZH.expandSessionFiles}
            className="flex h-7 w-7 items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
            onClick={toggleFiles}
          >
            <Files className="h-4 w-4" />
          </button>
        </div>
        {sessionFiles.length > 0 ? (
          <span className="pt-1 text-center text-[10px] tabular-nums text-zinc-500">{sessionFiles.length}</span>
        ) : null}
      </aside>
    );
  }

  const active = sessionFiles.find((file) => file.path === activePath) ?? sessionFiles[0];
  return (
    <ChangesSidebar
      key={`${sessionId}:${epoch}`}
      files={sessionFiles}
      activePath={activePath}
      rowAttr="data-session-file"
      mark="session"
      width={width}
      onSelect={(file) => {
        setActivePath(file.path);
        openDiff(`session:${file.path}`, baseName(file.path), [file]);
      }}
      onJump={() => {
        if (active) openHref(active.path);
      }}
      onRefresh={() => {
        setFileFilter("");
        setEpoch((value) => value + 1);
      }}
      onOpenExternal={() => {
        if (!active) return;
        return backend.openProjectFile(projectId, active.path);
      }}
      onHide={toggleFilesSidebar}
      empty={
        <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">{DESKTOP_ZH.noFileChanges}</p>
      }
    />
  );
}
