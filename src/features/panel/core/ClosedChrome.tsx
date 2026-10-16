import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { cn } from "@/lib/utils";
import { registerBuiltinViewers } from "../viewers/register";
import { viewerById } from "./registry";
import { Hint } from "./Hint";
import { useDismissLayer } from "./useDismissLayer";
import { usePanel } from "./PanelProvider";
import { SessionUsageCluster } from "./SubscriptionUsageMeter";

registerBuiltinViewers();

/** 侧栏收起时的顶栏：标题在左，用量和标记在右。聊天占满其余宽度。 */
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
      className="relative z-20 flex h-11 shrink-0 items-center gap-2 border-b border-[#222] bg-[#0f0f0f] px-4"
    >
      <span data-session-title className="min-w-0 flex-1 truncate text-[14px] font-medium text-[#e8e8e8]">
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
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[#333] text-[#cfcfcf] hover:bg-[#1c1c1c]"
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
            className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-[#333] bg-transparent px-1.5 text-[13px] font-medium tabular-nums text-[#e8e8e8] hover:bg-[#1c1c1c]"
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
            className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-[#333] bg-transparent px-1.5 text-[#cfcfcf] hover:bg-[#1c1c1c]"
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
      className="absolute right-0 top-full z-40 mt-1 w-48 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
    >
      <div className="px-3 py-1.5 text-[11px] text-zinc-500">{DESKTOP_ZH.panelOpenTabsMenu}</div>
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
            className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-100 hover:bg-zinc-800")}
            onClick={() => onPick(tab.id)}
          >
            {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-400" /> : null}
            <span className="min-w-0 flex-1 truncate">{title}</span>
          </button>
        );
      })}
    </div>
  );
}
