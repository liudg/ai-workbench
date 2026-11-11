import { useCallback } from "react";
import { Plus, X } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { cn } from "@/lib/utils";
import { registerBuiltinViewers } from "../viewers/register";
import { viewerById, type PanelTab } from "./registry";
import { Hint } from "./Hint";
import { PanelLayoutControls } from "./PanelChrome";
import { usePanel } from "./PanelProvider";
import { SidebarToggle } from "./SidebarToggle";
import { SessionUsageCluster } from "./SubscriptionUsageMeter";

registerBuiltinViewers();

export function PanelTabs() {
  const { tabs, activeId, selectTab, closeTab, openBlank, setTabTitle, projectId, sessionId, layout, sessionTitle } =
    usePanel();
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[tabs.length - 1];
  if (!active) return null;
  const menu = viewerById(active.viewerId)?.menu;

  return (
    <section
      data-preview-panel
      className="flex h-full w-full min-w-0 flex-col bg-[var(--wb-diff-well)]"
    >
      <div className="relative z-20 flex h-11 shrink-0 items-center border-b border-[var(--wb-border)] bg-[var(--wb-header)] px-1.5 backdrop-blur-md">
        {layout === "full" ? (
          <div className="flex max-w-[36%] shrink-0 items-center gap-1.5 pl-2.5 pr-2">
            <SidebarToggle />
            <span data-session-title className="min-w-0 truncate text-[13.5px] font-medium text-[var(--wb-text-strong)]">
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
                className={cn(
                  "my-1.5 flex min-w-0 max-w-[180px] items-center rounded-lg transition-colors",
                  selected
                    ? "bg-[var(--wb-chip)] font-medium text-[var(--wb-text-strong)]"
                    : "text-[var(--wb-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text)]",
                )}
              >
                <button
                  type="button"
                  data-preview-tab={tab.viewerId}
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left text-xs"
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
                  className="mr-1 rounded p-0.5 text-[var(--wb-faint)] hover:bg-[var(--wb-hover-strong)] hover:text-[var(--wb-text-strong)]"
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
              className="my-1 shrink-0 rounded-md px-1.5 text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]"
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
          className="flex shrink-0 items-center gap-1 border-b border-[var(--wb-border)] bg-[var(--wb-canvas)] px-2 py-1"
          data-viewer-menu={active.viewerId}
        >
          {menu.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={item.disabled}
              className="rounded px-2 py-0.5 text-xs text-[var(--wb-text)] hover:bg-[var(--wb-hover)] disabled:text-[var(--wb-faint)]"
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
