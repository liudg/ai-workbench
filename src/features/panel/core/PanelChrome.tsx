import { Plus } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { usePanel } from "./PanelProvider";

/** 侧栏收起时右上角的标记：没有标签是加号，有标签则是数量。 */
export function PanelMarker() {
  const { tabs, showPanel } = usePanel();
  const count = tabs.length;
  const label = count > 0 ? DESKTOP_ZH.panelOpenTabCount.replace("{count}", String(count)) : DESKTOP_ZH.panelNewTab;
  return (
    <button
      type="button"
      data-panel-marker
      data-open-tabs={count}
      aria-label={label}
      title={label}
      className="inline-flex h-7 min-w-7 items-center justify-center rounded-lg border border-zinc-500/80 bg-zinc-950 px-1.5 text-[13px] font-medium tabular-nums text-zinc-100 hover:bg-zinc-800"
      onClick={showPanel}
    >
      {count > 0 ? count : <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />}
    </button>
  );
}

/** 侧栏打开时，标签栏右侧：进入完整视图，以及收起侧栏。 */
export function PanelLayoutControls() {
  const { layout, toggleFull, hidePanel } = usePanel();
  const full = layout === "full";
  const fullLabel = full ? DESKTOP_ZH.panelExitFull : DESKTOP_ZH.panelEnterFull;
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1 pr-1">
      <button
        type="button"
        data-panel-full
        aria-pressed={full}
        aria-label={fullLabel}
        title={fullLabel}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
        onClick={toggleFull}
      >
        <FullViewIcon />
      </button>
      <button
        type="button"
        data-panel-hide
        aria-label={DESKTOP_ZH.panelHideTabs}
        title={DESKTOP_ZH.panelHideTabs}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
        onClick={hidePanel}
      >
        <PanelSquareIcon />
      </button>
    </div>
  );
}

function FullViewIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="M6.2 2.2H3.4A1.2 1.2 0 0 0 2.2 3.4v2.8M9.8 2.2h2.8a1.2 1.2 0 0 1 1.2 1.2v2.8M6.2 13.8H3.4a1.2 1.2 0 0 1-1.2-1.2V9.8M9.8 13.8h2.8a1.2 1.2 0 0 0 1.2-1.2V9.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PanelSquareIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
