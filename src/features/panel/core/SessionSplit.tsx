import { useRef, useState, type ReactNode } from "react";

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
import { PanelTabs } from "./PanelTabs";
import { usePanel } from "./PanelProvider";

const SPLITTER_WIDTH = 6;

export function SessionSplit({ children }: { children: ReactNode }) {
  const { tabs, activeId, filesExpanded, filesSidebarOpen, toggleFilesSidebar } = usePanel();
  const rowRef = useRef<HTMLDivElement>(null);
  const rowWidth = useElementWidth(rowRef);
  const [panelOverride, setPanelOverride] = useState<number | null>(null);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[tabs.length - 1];
  const panelOpen = Boolean(active);
  const filesVisible = !active || active.viewerId !== "diff";
  const showFiles = filesVisible && filesSidebarOpen;
  const measured = rowWidth > 0;
  const layoutWidth = panelOpen ? Math.max(0, rowWidth - SPLITTER_WIDTH) : rowWidth;
  const columns = workspaceColumns({
    rowWidth: layoutWidth,
    panelOpen,
    filesExpanded,
    filesVisible: showFiles,
  });
  const filesWidth = measured ? columns.files : filesColumnWidth(filesExpanded, showFiles);
  const panelWidth =
    panelOverride === null ? columns.panel : panelWidthAfterDrag(layoutWidth, filesWidth, panelOverride);
  const metrics = useRef({ row: 0, files: 0, panel: 0 });
  metrics.current = { row: layoutWidth, files: filesWidth, panel: columns.panel };

  return (
    <div ref={rowRef} data-workspace-row className="relative flex h-full min-w-0 flex-1 overflow-hidden">
      <div
        data-chat-column
        className="relative flex h-full min-w-0 flex-col overflow-hidden"
        style={{ flex: "1 1 0px", minWidth: CHAT_MIN_WIDTH }}
      >
        {children}
      </div>
      {panelOpen ? (
        <ColumnSplitter
          name="chat-preview"
          onDelta={(dx) => {
            setPanelOverride((prev) => {
              const current = prev ?? metrics.current.panel;
              return panelWidthAfterDrag(metrics.current.row, metrics.current.files, current - dx);
            });
          }}
        />
      ) : null}
      {panelOpen ? (
        <div
          className="flex h-full min-w-0 overflow-hidden"
          style={
            panelOverride !== null || measured
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
  );
}
