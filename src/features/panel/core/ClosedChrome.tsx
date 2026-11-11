import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { cn } from "@/lib/utils";
import { registerBuiltinViewers } from "../viewers/register";
import { viewerById } from "./registry";
import { Hint } from "./Hint";
import { SidebarToggle } from "./SidebarToggle";
import { useDismissLayer } from "./useDismissLayer";
import { usePanel } from "./PanelProvider";
import { SessionUsageCluster } from "./SubscriptionUsageMeter";

registerBuiltinViewers();

/** 会话顶栏：侧栏开关和标题在左，用量和标记在右。 */
export function ClosedChrome() {
  const { tabs, sessionTitle, showPanel, selectTab, openBlank, layout } = usePanel();
  const count = tabs.length;
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusMenu = useRef(false);
  useDismissLayer(menu, () => setMenu(false));
  useEffect(() => {
    if (!menu || !focusMenu.current) return;
    focusMenu.current = false;
    menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  }, [menu]);

  return (
    <div
      data-chat-header=""
      data-panel-closed={layout === "chat" ? "" : undefined}
      className="relative z-20 flex h-11 shrink-0 items-center gap-2 border-b border-[var(--wb-border)] bg-[var(--wb-header)] px-4 backdrop-blur-md"
    >
      <SidebarToggle />
      <span data-session-title className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-[var(--wb-text-strong)]">
        {sessionTitle}
      </span>
      <SessionUsageCluster />
      {layout !== "chat" ? (
        <Hint label={DESKTOP_ZH.panelNewTab} shortcut={DESKTOP_ZH.panelShortcutB} align="end">
          <button
            type="button"
            data-panel-marker
            data-open-tabs={count}
            aria-label={`${DESKTOP_ZH.panelNewTab} ${DESKTOP_ZH.panelShortcutB}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--wb-border-strong)] text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]"
            onClick={openBlank}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </Hint>
      ) : count > 0 ? (
        <div
          ref={menuRef}
          className="relative"
          onMouseEnter={() => setMenu(true)}
          onMouseLeave={() => setMenu(false)}
        >
          <button
            type="button"
            data-panel-marker
            data-open-tabs={count}
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-label={DESKTOP_ZH.panelOpenTabsMenu}
            className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-[var(--wb-border-strong)] bg-transparent px-1.5 text-[13px] font-medium tabular-nums text-[var(--wb-text-strong)] transition-colors hover:bg-[var(--wb-hover)]"
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              const item = menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']");
              if (menu && item) {
                item.focus();
                return;
              }
              focusMenu.current = true;
              setMenu(true);
            }}
            onClick={() => {
              showPanel();
              setMenu(false);
            }}
          >
            {count}
          </button>
          {menu ? (
            <OpenTabsMenu
              onPick={(id) => {
                selectTab(id);
                showPanel();
                setMenu(false);
              }}
            />
          ) : null}
        </div>
      ) : (
        <Hint label={DESKTOP_ZH.panelNewTab} shortcut={DESKTOP_ZH.panelShortcutB} align="end">
          <button
            type="button"
            data-panel-marker
            data-open-tabs={0}
            aria-label={`${DESKTOP_ZH.panelNewTab} ${DESKTOP_ZH.panelShortcutB}`}
            className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-[var(--wb-border-strong)] bg-transparent px-1.5 text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]"
            onClick={showPanel}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </Hint>
      )}
    </div>
  );
}

function OpenTabsMenu({ onPick }: { onPick: (id: string) => void }) {
  const { tabs } = usePanel();
  return (
    <div
      role="menu"
      data-open-tabs-menu
      className="absolute right-0 top-full z-40 mt-1 w-48 rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] py-1 shadow-[var(--wb-float-shadow)]"
    >
      <div className="px-3 py-1.5 text-[11px] text-[var(--wb-faint)]">{DESKTOP_ZH.panelOpenTabsMenu}</div>
      {tabs.map((tab) => {
        const viewer = viewerById(tab.viewerId);
        const Icon = viewer?.icon;
        const title = viewer ? viewer.title(tab.payload) : "";
        return (
          <button
            key={tab.id}
            type="button"
            role="menuitem"
            data-open-tab={tab.id}
            data-open-tab-viewer={tab.viewerId}
            className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--wb-text-strong)] hover:bg-[var(--wb-hover)]")}
            onClick={() => onPick(tab.id)}
          >
            {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--wb-muted)]" /> : null}
            <span className="min-w-0 flex-1 truncate">{title}</span>
          </button>
        );
      })}
    </div>
  );
}
