import { useCallback } from "react";
import { Plus, X } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { cn } from "@/lib/utils";
import { registerBuiltinViewers } from "../viewers/register";
import { viewerById, type PanelTab } from "./registry";
import { Hint } from "@/components/ui/hint";
import { SidebarToggle } from "@/shared/shell/SidebarToggle";
import { PanelLayoutControls } from "./PanelChrome";
import { usePanel } from "./PanelProvider";
import { SessionUsageCluster } from "./SubscriptionUsageMeter";
import { useTabContextMenu } from "./useTabContextMenu";

registerBuiltinViewers();

export function PanelTabs() {
  const { tabs, activeId, selectTab, closeTab, openBlank, setTabTitle, projectId, sessionId, layout, sessionTitle } =
    usePanel();
  const tabMenu = useTabContextMenu(tabs.map((tab) => tab.id), (ids) => ids.forEach(closeTab));
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[tabs.length - 1];
  if (!active) return null;
  const menu = viewerById(active.viewerId)?.menu;

  return (
    <section
      data-preview-panel
      className="flex h-full w-full min-w-0 flex-col border-l border-wb-border bg-wb-panel"
    >
      <div className="relative z-20 flex h-11 shrink-0 items-center border-b border-wb-border bg-wb-panel px-1.5">
        {layout === "full" ? (
          <div className="flex max-w-[36%] shrink-0 items-center gap-2 pl-2.5 pr-2">
            <SidebarToggle />
            <span data-session-title className="truncate text-xs font-medium text-wb-fg-2">
              {sessionTitle}
            </span>
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto px-1">
          {tabs.map((tab) => {
            const selected = tab.id === active.id;
            const viewer = viewerById(tab.viewerId);
            const Icon = viewer?.icon;
            const title = viewer ? viewer.title(tab.payload) : "";
            return (
              <div
                key={tab.id}
                onContextMenu={(event) => tabMenu.open(event, tab.id)}
                className={cn(
                  "my-1.5 flex min-w-0 max-w-[180px] items-center rounded-lg transition-colors",
                  selected ? "bg-wb-active text-wb-fg shadow-[inset_0_0_0_1px_var(--color-wb-border)]" : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
                )}
              >
                <button
                  type="button"
                  data-preview-tab={tab.viewerId}
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left text-xs font-medium"
                  onClick={() => selectTab(tab.id)}
                >
                  {Icon ? (
                    <span className="inline-flex shrink-0" data-tab-icon={tab.viewerId}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                  ) : null}
                  <span className="truncate">{title}</span>
                </button>
                <button
                  type="button"
                  aria-label={DESKTOP_ZH.closeTab}
                  className="mr-1 rounded p-0.5 text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg"
                  onClick={() => closeTab(tab.id)}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          <Hint label={DESKTOP_ZH.panelOpenSideTab}>
            <button
              type="button"
              data-browser-new-tab
              aria-label={DESKTOP_ZH.panelOpenSideTab}
              className="my-1.5 shrink-0 rounded-lg px-1.5 text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
              onClick={openBlank}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </Hint>
        </div>
        {layout === "full" ? <SessionUsageCluster /> : null}
        <PanelLayoutControls />
      </div>
      {menu && menu.length > 0 ? (
        <div
          className="flex shrink-0 items-center gap-1 border-b border-wb-border bg-wb-panel px-2 py-1"
          data-viewer-menu={active.viewerId}
        >
          {menu.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={item.disabled}
              className="rounded-md px-2 py-0.5 text-xs text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg disabled:text-wb-fg-3"
              onClick={() => item.onSelect?.()}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        <TabBody
          key={`${sessionId}:${active.id}`}
          tab={active}
          projectId={projectId}
          sessionId={sessionId}
          onTitle={setTabTitle}
        />
      </div>
      {tabMenu.menu}
    </section>
  );
}

function TabBody({
  tab,
  projectId,
  sessionId,
  onTitle,
}: {
  tab: PanelTab;
  projectId: string;
  sessionId: string;
  onTitle: (id: string, title: string) => void;
}) {
  const viewer = viewerById(tab.viewerId);
  const setTitle = useCallback((title: string) => onTitle(tab.id, title), [onTitle, tab.id]);
  if (!viewer) return null;
  const View = viewer.View;
  return (
    <View
      tabId={tab.id}
      payload={tab.payload}
      status={tab.status}
      sessionId={sessionId}
      projectId={projectId}
      setTitle={setTitle}
    />
  );
}
