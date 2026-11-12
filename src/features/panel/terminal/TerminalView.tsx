import { useCallback } from "react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { usePanel } from "../core/PanelProvider";
import type { ViewerViewProps } from "../core/registry";
import { useTerminal, type TerminalPayload } from "./useTerminal";

export function TerminalView({ tabId, payload, sessionId }: ViewerViewProps<TerminalPayload>) {
  const { patchTabPayload, data } = usePanel();
  const patchPayload = useCallback(
    (patch: Partial<TerminalPayload>) => patchTabPayload(tabId, patch),
    [patchTabPayload, tabId],
  );
  const { hostRef, exited, exitCode, error, restart } = useTerminal({
    tabId,
    sessionId,
    terminalId: payload?.terminalId,
    open: data.openTerminal,
    patchPayload,
  });
  const notice = error ?? (exited ? exitNotice(exitCode) : null);
  return (
    <div data-terminal-view className="flex h-full flex-col bg-wb-panel text-wb-fg">
      <div ref={hostRef} className="min-h-0 flex-1 bg-wb-panel py-2 pl-3 text-wb-fg" />
      {notice ? (
        <div className="flex shrink-0 items-center gap-3 border-t border-wb-border px-3 py-2 text-xs text-wb-fg-2">
          <span className="min-w-0 flex-1 truncate">{notice}</span>
          <button
            type="button"
            className="shrink-0 rounded-lg border border-wb-border bg-wb-elev px-2.5 py-1 text-wb-fg hover:bg-wb-hover"
            onClick={restart}
          >
            {DESKTOP_ZH.terminalRestart}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function exitNotice(code: number | null): string {
  return code == null ? DESKTOP_ZH.terminalExited : DESKTOP_ZH.terminalExitedWithCode.replace("{code}", String(code));
}
