import { useEffect, useRef, useState } from "react";

import { useElementWidth } from "@/shared/dom/useElementWidth";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { baseName } from "@/shared/path";
import { ColumnSplitter } from "../core/ColumnSplitter";
import { FILES_EXPANDED_WIDTH, nextDraggedListWidth, paneFileColumnWidth, pinnedColumnStyle } from "../core/layout";
import { resolvePreviewPath } from "../core/preview-kind";
import { useColumnGesture } from "../core/useColumnGesture";
import { usePanel, usePanelData } from "../core/PanelProvider";
import { ContextMenu } from "@/shared/menu/ContextMenu";
import { FilePreviewColumn } from "./FilePreview";
import { useFilePreviewChrome } from "./use-file-preview-chrome";
import { FileTabs } from "./FileTabs";
import { PreviewChrome } from "./PreviewChrome";
import {
  canonicalOpenPath,
  clearOpenFilesOnScope,
  closeOpenFile,
  keepOpenFile,
  openFileInPlace,
  openFilesPlace,
  selectOpenFile,
} from "./open-files-place";
import { WorkspaceTree } from "./WorkspaceTree";
import { useAttachFile } from "./useAttachFile";
import { usePickPreviewFile } from "./useOpenProjectFile";

const SPLITTER_WIDTH = 6;

/** 打开文件：文件标签下面一行顶栏横跨预览和文件树，下面两栏顶部齐平。 */
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
  } = usePanel();
  return (
    <OpenFilesScreen
      tabs={tabs}
      projectId={projectId}
      projectPath={projectPath}
      sessionId={sessionId}
      filesTreeWidth={filesTreeWidth}
      setFilesTreeWidth={setFilesTreeWidth}
      filesTreeOpen={filesTreeOpen}
      toggleFilesTree={toggleFilesTree}
      patchTabPayload={patchTabPayload}
    />
  );
}

export function OpenFilesScreen({
  tabs,
  projectId,
  projectPath,
  sessionId,
  filesTreeWidth,
  setFilesTreeWidth,
  filesTreeOpen,
  toggleFilesTree,
  patchTabPayload,
}: {
  tabs: readonly { id: string; viewerId: string; payload: unknown }[];
  projectId: string;
  projectPath: string;
  sessionId: string;
  filesTreeWidth: number | null;
  setFilesTreeWidth: (width: number) => void;
  filesTreeOpen: boolean;
  toggleFilesTree: () => void;
  patchTabPayload: (tabId: string, patch: Record<string, unknown>) => void;
}) {
  const panelData = usePanelData();
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

  const openFile = (path: string, intent: { isPreview: boolean }, line?: number | null) => {
    const canonical = canonicalOpenPath(projectPath, path);
    if (!canonical) return;
    writePlace(openFileInPlace(place, canonical, line ?? null, intent.isPreview));
  };

  const selectFile = (path: string) => {
    writePlace(selectOpenFile(place, path));
  };

  const closeFiles = (paths: readonly string[]) => {
    writePlace(paths.reduce((next, path) => closeOpenFile(next, path), place));
  };

  const addFile = () => {
    void pickPreviewFile().then((picked) => {
      if (!picked) return;
      openFile(picked, { isPreview: true }, null);
    });
  };

  const chrome = useFilePreviewChrome({
    projectId,
    projectPath,
    previewPath: place.path,
    treeOpen: filesTreeOpen,
    onToggleTree: toggleFilesTree,
    onSelectFile: openFile,
  });

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
  };

  return (
    <div
      ref={frameRef}
      data-open-files
      data-file-tree={listWidth !== null ? "visible" : "hidden"}
      className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <FileTabs
        tabs={place.tabs}
        activePath={place.path}
        onSelect={selectFile}
        onKeepOpen={(path) => writePlace(keepOpenFile(place, path))}
        onClose={closeFiles}
        onAdd={addFile}
      />
      <PreviewChrome {...chrome.chromeProps} />
      <div data-open-files-split className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <FilePreviewColumn
          projectId={projectId}
          previewPath={place.path}
          previewLine={place.line}
          markdownMode={chrome.markdownMode}
          onToggleMarkdown={chrome.chromeProps.onToggleMarkdown}
          quotePath={place.path ? resolvePreviewPath(projectPath, place.path) || place.path : ""}
          onQuote={(draft) => panelData.addTextSnippet(sessionId, draft)}
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
            className="flex h-full min-h-0 flex-col overflow-hidden border-l border-wb-border bg-wb-panel"
          >
            <div className="flex shrink-0 items-center gap-1.5 border-b border-wb-border p-2">
              <input
                value={place.filter}
                onChange={(event) => {
                  if (!filesTab) return;
                  patchTabPayload(filesTab.id, { filter: event.target.value });
                }}
                placeholder={DESKTOP_ZH.filterFiles}
                aria-label={DESKTOP_ZH.filterFiles}
                data-files-filter
                className="w-full min-w-0 rounded-lg border border-wb-border-strong bg-wb-input px-2.5 py-1.5 text-[12px] text-wb-fg outline-none transition-colors placeholder:text-wb-dim focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft"
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
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[{ id: "add-to-chat", label: DESKTOP_ZH.addToChat, onSelect: () => addToChat(contextMenu.path) }]}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
      {chrome.searchDialog}
    </div>
  );
}
