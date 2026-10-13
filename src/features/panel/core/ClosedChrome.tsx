import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { cn } from "@/lib/utils";
import { registerBuiltinViewers } from "../viewers/register";
import { viewerById } from "./registry";
import { Hint } from "./Hint";
import { usePanel } from "./PanelProvider";

registerBuiltinViewers();

/** 侧栏收起时的顶栏：标题在左，右侧是标记。聊天占满其余宽度。 */
export function ClosedChrome() {
  const { tabs, sessionTitle, showPanel, selectTab } = usePanel();
  const count = tabs.length;
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  return (
    <div
      data-panel-closed
      className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3"
    >
      <span data-session-title className="min-w-0 flex-1 truncate text-sm text-zinc-100">
        {sessionTitle}
      </span>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-zinc-700" />
      {count > 0 ? (
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
            className="inline-flex h-7 min-w-7 items-center justify-center rounded-lg border border-zinc-500/80 bg-zinc-950 px-1.5 text-[13px] font-medium tabular-nums text-zinc-100 hover:bg-zinc-800"
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
            className="inline-flex h-7 min-w-7 items-center justify-center rounded-lg border border-zinc-500/80 bg-zinc-950 px-1.5 text-zinc-100 hover:bg-zinc-800"
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
