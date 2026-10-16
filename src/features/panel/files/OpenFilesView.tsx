import { useEffect, useRef, useState } from "react";

import { useElementWidth } from "@/shared/dom/useElementWidth";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { addSessionTextSnippet } from "../core/useAddTextSnippet";
import { ColumnSplitter } from "../core/ColumnSplitter";
import { FILES_EXPANDED_WIDTH, diffListWidth, diffListWidthAfterDrag, pinnedColumnStyle } from "../core/layout";
import { resolvePreviewPath } from "../core/preview-kind";
import { usePanel } from "../core/PanelProvider";
import { FileContextMenu } from "./FileContextMenu";
import { FilePreviewColumn } from "./FilePreview";
import { WorkspaceTree } from "./WorkspaceTree";
import { baseName } from "@/shared/path";
import { useAttachFile } from "./useAttachFile";

const SPLITTER_WIDTH = 6;

/** 打开文件：左侧是预览，右侧是工作区树。选中文件留在当前页。 */
export function OpenFilesView() {
  const {
    projectId,
    projectPath,
    sessionId,
    diffFilesWidth,
    setDiffFilesWidth,
    filesTreeOpen,
    toggleFilesTree,
  } = usePanel();
  const attachFile = useAttachFile(sessionId);
  const [filter, setFilter] = useState("");
  const [previewPath, setPreviewPath] = useState("");
  const [previewLine, setPreviewLine] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const paneWidth = useElementWidth(frameRef);
  const inner = Math.max(0, paneWidth - SPLITTER_WIDTH);
  const auto = diffListWidth(inner);
  const dragged = diffFilesWidth !== null ? diffListWidthAfterDrag(inner, diffFilesWidth) : null;
  const sized =
    paneWidth <= 0 ? FILES_EXPANDED_WIDTH : (dragged ?? auto ?? Math.min(FILES_EXPANDED_WIDTH, inner));
  const listWidth = filesTreeOpen ? sized : null;
  const metrics = useRef({ pane: 0, list: 0 });
  const widthRef = useRef(diffFilesWidth);
  metrics.current = { pane: inner, list: listWidth ?? auto ?? 0 };
  if (diffFilesWidth !== null) widthRef.current = diffFilesWidth;

  const openFile = (path: string, _intent: { isPreview: true }, line?: number | null) => {
    setPreviewPath(path);
    setPreviewLine(line ?? null);
  };

  useEffect(() => {
    setPreviewPath("");
    setPreviewLine(null);
  }, [projectId]);

  const addToChat = (path: string) => {
    const absolute = resolvePreviewPath(projectPath, path);
    if (!absolute) return;
    attachFile(absolute, baseName(absolute));
    setContextMenu(null);
  };

  return (
    <div
      ref={frameRef}
      data-open-files
      data-file-tree={listWidth !== null ? "visible" : "hidden"}
      className="relative flex h-full min-h-0 min-w-0 overflow-hidden"
    >
      <FilePreviewColumn
        projectId={projectId}
        projectPath={projectPath}
        previewPath={previewPath}
        previewLine={previewLine}
        treeOpen={filesTreeOpen}
        onToggleTree={toggleFilesTree}
        onSelectFile={openFile}
        quotePath={previewPath ? resolvePreviewPath(projectPath, previewPath) || previewPath : ""}
        onQuote={(draft) => addSessionTextSnippet(sessionId, draft)}
      />
      {listWidth !== null ? (
        <ColumnSplitter
          name="open-files"
          onDelta={(dx) => {
            const pane = metrics.current.pane;
            const base = widthRef.current ?? metrics.current.list;
            const current = diffListWidthAfterDrag(pane, base) ?? base;
            const next = diffListWidthAfterDrag(pane, current - dx);
            if (next === null) return;
            widthRef.current = next;
            setDiffFilesWidth(next);
          }}
        />
      ) : null}
      {listWidth !== null ? (
        <aside
          data-workspace-tree
          data-tree-surface="sidebar"
          style={pinnedColumnStyle(listWidth)}
          className="flex h-full min-h-0 flex-col overflow-hidden border-l border-[#222] bg-[#0f0f0f]"
        >
          <div className="flex shrink-0 items-center gap-1 border-b border-[#222] p-2">
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={DESKTOP_ZH.filterFiles}
              aria-label={DESKTOP_ZH.filterFiles}
              data-files-filter
              className="w-full min-w-0 rounded-md border border-[#2a2a2a] bg-[#171717] px-2 py-1.5 text-[12px] text-[#e8e8e8] outline-none placeholder:text-[#666] focus:border-[#3a3a3a]"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-1">
            <WorkspaceTree
              projectId={projectId}
              filter={filter}
              activePath={previewPath}
              surface="sidebar"
              directoryPath=""
              onSelectFile={(path, intent) => openFile(path, intent)}
              onContextMenu={(path, event) => setContextMenu({ x: event.clientX, y: event.clientY, path })}
            />
          </div>
        </aside>
      ) : null}
      {contextMenu ? (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onAdd={() => addToChat(contextMenu.path)}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}
