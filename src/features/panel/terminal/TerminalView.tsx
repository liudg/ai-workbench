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
    <div data-terminal-view className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      <div ref={hostRef} className="min-h-0 flex-1 bg-zinc-950 py-2 pl-3 text-zinc-100" />
      {notice ? (
        <div className="flex shrink-0 items-center gap-3 border-t border-zinc-800 px-3 py-2 text-xs text-zinc-400">
          <span className="min-w-0 flex-1 truncate">{notice}</span>
          <button
            type="button"
            className="shrink-0 rounded-md px-2 py-1 text-zinc-100 hover:bg-zinc-800"
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
