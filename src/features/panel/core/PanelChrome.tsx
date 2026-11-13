import { Hint } from "@/components/ui/hint";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { FullViewIcon, PanelSquareIcon } from "./panel-icons";
import { usePanel } from "./PanelProvider";

/** 标签栏右侧：完整视图，以及收起侧栏。 */
export function PanelLayoutControls() {
  const { layout, toggleFull, hidePanel } = usePanel();
  const full = layout === "full";
  const fullLabel = full ? DESKTOP_ZH.panelExitFull : DESKTOP_ZH.panelEnterFull;
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1 pr-1">
      <Hint label={fullLabel} shortcut={DESKTOP_ZH.panelShortcutF} align="end">
        <button
          type="button"
          data-panel-full
          aria-pressed={full}
          aria-label={`${fullLabel} ${DESKTOP_ZH.panelShortcutF}`}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
          onClick={toggleFull}
        >
          <FullViewIcon exit={full} />
        </button>
      </Hint>
      {full ? null : (
        <Hint label={DESKTOP_ZH.panelHideTabs} shortcut={DESKTOP_ZH.panelShortcutB} align="end">
          <button
            type="button"
            data-panel-hide
            aria-label={`${DESKTOP_ZH.panelHideTabs} ${DESKTOP_ZH.panelShortcutB}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
            onClick={hidePanel}
          >
            <PanelSquareIcon />
          </button>
        </Hint>
      )}
    </div>
  );
}
