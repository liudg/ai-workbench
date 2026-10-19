import { useEffect, useRef, useState } from "react";

import { useElementWidth } from "@/shared/dom/useElementWidth";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { baseName } from "@/shared/path";
import { addSessionTextSnippet } from "../core/useAddTextSnippet";
import { ColumnSplitter } from "../core/ColumnSplitter";
import { FILES_EXPANDED_WIDTH, nextDraggedListWidth, paneFileColumnWidth, pinnedColumnStyle } from "../core/layout";
import { opensLocalHtmlInBrowser, resolvePreviewPath } from "../core/preview-kind";
import { useColumnGesture } from "../core/useColumnGesture";
import { usePanel } from "../core/PanelProvider";
import { FileContextMenu } from "./FileContextMenu";
import { FilePreviewColumn } from "./FilePreview";
import { FileTabs } from "./FileTabs";
import {
  canonicalOpenPath,
  clearOpenFilesOnScope,
  closeOpenFile,
  openFileInPlace,
  openFilesPlace,
  selectOpenFile,
} from "./open-files-place";
import { WorkspaceTree } from "./WorkspaceTree";
import { useAttachFile } from "./useAttachFile";
import { usePickPreviewFile } from "./useOpenProjectFile";

const SPLITTER_WIDTH = 6;

/** 打开文件：左侧是预览，右侧是工作区树。选中文件留在当前页。 */
export function OpenFilesView() {
  const {
    tabs,
    projectId,
    projectPath,
    sessionId,
    filesTreeWidth,
    setFilesTreeWidth,
    filesTreeOpen,
    toggleFilesTree,
    patchTabPayload,
    openHref,
  } = usePanel();
  const filesTab = tabs.find((tab) => tab.viewerId === "files");
  const place = openFilesPlace(filesTab?.payload);
  const attachFile = useAttachFile(sessionId);
  const pickPreviewFile = usePickPreviewFile();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const seenScope = useRef({ projectId, sessionId });
  const paneWidth = useElementWidth(frameRef);
  const inner = Math.max(0, paneWidth - SPLITTER_WIDTH);
  const listWidth = paneFileColumnWidth({
    paneWidth,
    splitter: SPLITTER_WIDTH,
    wanted: filesTreeOpen,
    dragged: filesTreeWidth,
    beforeMeasure: FILES_EXPANDED_WIDTH,
    keepWhenNarrow: true,
  });
  const metrics = useRef({ pane: 0, list: 0 });
  const drag = useColumnGesture(listWidth ?? 0, sessionId);
  metrics.current = { pane: inner, list: listWidth ?? 0 };

  const writePlace = (next: ReturnType<typeof openFilesPlace>) => {
    if (!filesTab) return;
    patchTabPayload(filesTab.id, { path: next.path, line: next.line, tabs: next.tabs, filter: next.filter });
  };

  const openFile = (path: string, _intent: { isPreview: true }, line?: number | null) => {
    const canonical = canonicalOpenPath(projectPath, path);
    if (!canonical) return;
    if (opensLocalHtmlInBrowser(canonical, line)) {
      openHref(canonical);
      return;
    }
    writePlace(openFileInPlace(place, canonical, line ?? null));
  };

  const selectFile = (path: string) => {
    writePlace(selectOpenFile(place, path));
  };

  const closeFile = (path: string) => {
    writePlace(closeOpenFile(place, path));
  };

  const addFile = () => {
    void pickPreviewFile().then((picked) => {
      if (!picked) return;
      openFile(picked, { isPreview: true }, null);
    });
  };

  useEffect(() => {
    const previous = seenScope.current;
    seenScope.current = { projectId, sessionId };
    if (!clearOpenFilesOnScope(previous, { projectId, sessionId }) || !filesTab) return;
    patchTabPayload(filesTab.id, { path: "", line: null, filter: "", tabs: [] });
  }, [filesTab, patchTabPayload, projectId, sessionId]);

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
      className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <FileTabs tabs={place.tabs} activePath={place.path} onSelect={selectFile} onClose={closeFile} onAdd={addFile} />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <FilePreviewColumn
          projectId={projectId}
          projectPath={projectPath}
          previewPath={place.path}
          previewLine={place.line}
          treeOpen={filesTreeOpen}
          onToggleTree={toggleFilesTree}
          onSelectFile={openFile}
          quotePath={place.path ? resolvePreviewPath(projectPath, place.path) || place.path : ""}
          onQuote={(draft) => addSessionTextSnippet(sessionId, draft)}
        />
        {listWidth !== null ? (
          <ColumnSplitter
            name="open-files"
            onDelta={(dx) => {
              const next = nextDraggedListWidth(metrics.current.pane, drag.base(), dx);
              if (next === null) return;
              drag.remember(next);
              setFilesTreeWidth(next);
            }}
            onSettle={drag.settle}
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
                value={place.filter}
                onChange={(event) => {
                  if (!filesTab) return;
                  patchTabPayload(filesTab.id, { filter: event.target.value });
                }}
                placeholder={DESKTOP_ZH.filterFiles}
                aria-label={DESKTOP_ZH.filterFiles}
                data-files-filter
                className="w-full min-w-0 rounded-md border border-[#2a2a2a] bg-[#171717] px-2 py-1.5 text-[12px] text-[#e8e8e8] outline-none placeholder:text-[#666] focus:border-[#3a3a3a]"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-1">
              <WorkspaceTree
                projectId={projectId}
                sessionId={sessionId}
                filter={place.filter}
                activePath={place.path}
                surface="sidebar"
                directoryPath=""
                onSelectFile={(path, intent) => openFile(path, intent)}
                onContextMenu={(path, event) => setContextMenu({ x: event.clientX, y: event.clientY, path })}
              />
            </div>
          </aside>
        ) : null}
      </div>
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
