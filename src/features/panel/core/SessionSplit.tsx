import { useRef, type ReactNode } from "react";

import { useElementWidth } from "@/shared/dom/useElementWidth";
import { SessionFiles } from "../files/SessionFiles";
import {
  CHAT_MIN_WIDTH,
  PANEL_PREFERRED_WIDTH,
  filesColumnWidth,
  workspaceColumns,
} from "./layout";
import { PanelTabs } from "./PanelTabs";
import { usePanel } from "./PanelProvider";

export function SessionSplit({ children }: { children: ReactNode }) {
  const { tabs, activeId, filesExpanded } = usePanel();
  const rowRef = useRef<HTMLDivElement>(null);
  const rowWidth = useElementWidth(rowRef);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[tabs.length - 1];
  const panelOpen = Boolean(active);
  const filesVisible = !active || active.viewerId !== "diff";
  const measured = rowWidth > 0;
  const columns = workspaceColumns({ rowWidth, panelOpen, filesExpanded, filesVisible });
  const filesWidth = measured ? columns.files : filesColumnWidth(filesExpanded, filesVisible);

  return (
    <div ref={rowRef} data-workspace-row className="flex h-full min-w-0 flex-1 overflow-hidden">
      <div
        data-chat-column
        className="relative flex h-full min-w-0 flex-col overflow-hidden"
        style={{ flex: "1 1 0px", minWidth: CHAT_MIN_WIDTH }}
      >
        {children}
      </div>
      {panelOpen ? (
        <div
          className="flex h-full min-w-0 overflow-hidden"
          style={
            measured
              ? { width: columns.panel, maxWidth: columns.panel, flex: "0 1 auto", minWidth: 0 }
              : { flex: "0 1 auto", width: PANEL_PREFERRED_WIDTH, maxWidth: "44%", minWidth: 0 }
          }
        >
          <PanelTabs />
        </div>
      ) : null}
      {filesWidth > 0 ? <SessionFiles width={filesWidth} /> : null}
    </div>
  );
}
