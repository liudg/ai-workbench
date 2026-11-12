import { useMemo, useState, type ReactNode } from "react";
import { PanelRightClose } from "lucide-react";

import type { FileChange } from "@/features/changes-model";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { pinnedColumnStyle } from "../core/layout";
import { resolvePreviewPath } from "../core/preview-kind";
import { usePanel } from "../core/PanelProvider";
import { filterFiles, useFileFilter } from "../core/file-filter";
import { ContextMenu } from "@/shared/menu/ContextMenu";
import { FileTreeList } from "./FileTreeList";
import { buildFileTree } from "./file-tree";
import { baseName } from "@/shared/path";
import { useAttachFile } from "./useAttachFile";

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
  const { sessionId, projectPath } = usePanel();
  const attachFile = useAttachFile(sessionId);
  const [filter, setFilter] = useFileFilter(sessionId);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
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
      style={width ? pinnedColumnStyle(width) : undefined}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l border-wb-border bg-wb-panel"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-wb-border p-2">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={DESKTOP_ZH.filterFiles}
          aria-label={DESKTOP_ZH.filterFiles}
          data-files-filter
          {...(mark === "diff" ? { "data-diff-filter": "" } : {})}
          className="w-full min-w-0 rounded-lg border border-wb-border-strong bg-wb-input px-2.5 py-1.5 text-[12px] text-wb-fg outline-none transition-colors placeholder:text-wb-dim focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft"
        />
        {onHide ? (
          <button
            type="button"
            data-files-toggle
            title={DESKTOP_ZH.filesHideSidebar}
            aria-label={DESKTOP_ZH.filesHideSidebar}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
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
          <p className="px-2 py-6 text-center text-xs leading-5 text-wb-fg-3">{DESKTOP_ZH.noFileMatch}</p>
        ) : (
          <FileTreeList
            nodes={tree}
            collapsed={collapsed}
            activePath={activePath}
            rowAttr={rowAttr}
            showStats
            onToggle={toggleDir}
            onSelect={onSelect}
            onContextMenu={(file, event) => setContextMenu({ x: event.clientX, y: event.clientY, path: file.path })}
          />
        )}
      </div>
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            {
              id: "add-to-chat",
              label: DESKTOP_ZH.addToChat,
              onSelect: () => {
                const absolute = resolvePreviewPath(projectPath, contextMenu.path);
                if (absolute) attachFile(absolute, baseName(absolute));
              },
            },
          ]}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </aside>
  );
}
