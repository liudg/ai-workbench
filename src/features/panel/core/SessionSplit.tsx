import { useRef, type ReactNode } from "react";

import { useElementWidth } from "@/shared/dom/useElementWidth";
import {
  CHAT_MAX_WIDTH,
  PANEL_PREFERRED_WIDTH,
  filesColumnWidth,
  panelWidthAfterDrag,
  previewRowFileColumn,
  sidePanelOpen,
  workspaceColumns,
} from "./layout";
import { ColumnSplitter } from "./ColumnSplitter";
import { ClosedChrome } from "./ClosedChrome";
import { PanelTabs } from "./PanelTabs";
import { useColumnGesture } from "./useColumnGesture";
import { usePanel } from "./PanelProvider";

const SPLITTER_WIDTH = 6;

export function SessionSplit({ children }: { children: ReactNode }) {
  const { tabs, activeId, previewWidth, setPreviewWidth, layout, sessionId } = usePanel();
  const rowRef = useRef<HTMLDivElement>(null);
  const rowWidth = useElementWidth(rowRef);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[tabs.length - 1];
  const panelOpen = sidePanelOpen(layout, active ? 1 : 0);
  const full = panelOpen && layout === "full";
  const measured = rowWidth > 0;
  const layoutWidth = panelOpen && !full ? Math.max(0, rowWidth - SPLITTER_WIDTH) : rowWidth;
  const fileColumn = previewRowFileColumn();
  const filesWidth = filesColumnWidth(fileColumn.filesExpanded, fileColumn.filesVisible);
  const columns = workspaceColumns({
    rowWidth: layoutWidth,
    panelOpen,
    panelMode: full ? "full" : panelOpen ? "split" : "chat",
    filesExpanded: fileColumn.filesExpanded,
    filesVisible: fileColumn.filesVisible,
  });
  const panelWidth =
    !measured || previewWidth === null
      ? columns.panel
      : panelWidthAfterDrag(layoutWidth, filesWidth, previewWidth);
  const metrics = useRef({ row: 0, panel: 0 });
  const drag = useColumnGesture(panelWidth, sessionId);
  metrics.current = { row: layoutWidth, panel: panelWidth };

  const chatWidth = measured && panelOpen && !full ? Math.max(0, layoutWidth - panelWidth) : undefined;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-wb-surface">
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
            style={
              chatWidth !== undefined
                ? { width: chatWidth, flex: "0 0 auto", minWidth: 0, maxWidth: "none" }
                : panelOpen
                  ? { flex: "1 1 auto", minWidth: 0, maxWidth: CHAT_MAX_WIDTH }
                  : { flex: "1 1 auto", minWidth: 0 }
            }
          >
            <ClosedChrome />
            {children}
          </div>
        )}
        {panelOpen && !full ? (
          <ColumnSplitter
            name="chat-preview"
            onDelta={(dx) => {
              const next = panelWidthAfterDrag(metrics.current.row, filesWidth, drag.base() - dx);
              drag.remember(next);
              setPreviewWidth(next);
            }}
            onSettle={drag.settle}
          />
        ) : null}
        {panelOpen ? (
          <div
            className="flex h-full min-w-0 overflow-hidden"
            data-preview-width={full ? undefined : measured ? panelWidth : undefined}
            style={
              full
                ? { flex: "1 1 auto", width: "100%", maxWidth: "100%", minWidth: 0 }
                : measured
                  ? { width: panelWidth, maxWidth: panelWidth, flex: "0 0 auto", minWidth: 0 }
                  : { flex: "1 1 auto", width: PANEL_PREFERRED_WIDTH, minWidth: 0 }
            }
          >
            <PanelTabs />
          </div>
        ) : null}
      </div>
    </div>
  );
}
