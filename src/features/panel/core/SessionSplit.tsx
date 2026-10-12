import { useRef, type ReactNode } from "react";

import { useWorkbench } from "@/store";
import { useElementWidth } from "@/shared/dom/useElementWidth";
import { FilesToggle } from "../files/FilesToggle";
import { SessionFiles } from "../files/SessionFiles";
import {
  CHAT_MIN_WIDTH,
  PANEL_PREFERRED_WIDTH,
  filesColumnWidth,
  panelWidthAfterDrag,
  workspaceColumns,
} from "./layout";
import { ColumnSplitter } from "./ColumnSplitter";
import { PanelMarker } from "./PanelChrome";
import { PanelTabs } from "./PanelTabs";
import { usePanel } from "./PanelProvider";

const SPLITTER_WIDTH = 6;

export function SessionSplit({ children }: { children: ReactNode }) {
  const {
    sessionId,
    tabs,
    activeId,
    filesExpanded,
    filesSidebarOpen,
    toggleFilesSidebar,
    previewWidth,
    setPreviewWidth,
    layout,
  } = usePanel();
  const rowRef = useRef<HTMLDivElement>(null);
  const rowWidth = useElementWidth(rowRef);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[tabs.length - 1];
  const panelOpen = layout !== "chat" && Boolean(active);
  const full = panelOpen && layout === "full";
  const filesVisible = !active || active.viewerId !== "diff";
  const showFiles = filesVisible && filesSidebarOpen;
  const measured = rowWidth > 0;
  const layoutWidth = panelOpen && !full ? Math.max(0, rowWidth - SPLITTER_WIDTH) : rowWidth;
  const columns = workspaceColumns({
    rowWidth: layoutWidth,
    panelOpen,
    panelMode: full ? "full" : panelOpen ? "split" : "chat",
    filesExpanded,
    filesVisible: showFiles,
  });
  const filesWidth = measured ? columns.files : filesColumnWidth(filesExpanded, showFiles);
  const panelWidth =
    !measured || previewWidth === null
      ? columns.panel
      : panelWidthAfterDrag(layoutWidth, filesWidth, previewWidth);
  const metrics = useRef({ row: 0, files: 0, panel: 0 });
  metrics.current = { row: layoutWidth, files: filesWidth, panel: columns.panel };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {panelOpen ? null : (
        <div className="flex h-9 shrink-0 items-center justify-end px-2">
          <PanelMarker />
        </div>
      )}
      <div
        ref={rowRef}
        data-workspace-row
        data-panel-layout={full ? "full" : panelOpen ? "split" : "chat"}
        className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      >
      {full ? null : (
        <div
          data-chat-column
          className="relative flex h-full min-w-0 flex-col overflow-hidden"
          style={{ flex: "1 1 0px", minWidth: CHAT_MIN_WIDTH }}
        >
          {children}
        </div>
      )}
      {panelOpen && !full ? (
        <ColumnSplitter
          name="chat-preview"
          onDelta={(dx) => {
            const row = metrics.current.row;
            const files = metrics.current.files;
            const stored = useWorkbench.getState().previewWidthBySession[sessionId];
            const current = panelWidthAfterDrag(row, files, stored ?? metrics.current.panel);
            setPreviewWidth(panelWidthAfterDrag(row, files, current - dx));
          }}
        />
      ) : null}
      {panelOpen ? (
        <div
          className="flex h-full min-w-0 overflow-hidden"
          data-preview-width={full ? undefined : measured ? panelWidth : undefined}
          style={
            full
              ? { flex: "1 1 auto", minWidth: 0 }
              : measured
                ? { width: panelWidth, maxWidth: panelWidth, flex: "0 0 auto", minWidth: 0 }
                : { flex: "0 1 auto", width: PANEL_PREFERRED_WIDTH, maxWidth: "44%", minWidth: 0 }
          }
        >
          <PanelTabs />
        </div>
      ) : null}
      {showFiles && filesWidth > 0 ? <SessionFiles width={filesWidth} /> : null}
      {filesSidebarOpen ? null : <FilesToggle onShow={toggleFilesSidebar} />}
      </div>
    </div>
  );
}
