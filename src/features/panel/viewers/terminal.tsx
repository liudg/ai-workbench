import { SquareTerminal } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { payloadTitle, type PanelViewer } from "../core/registry";
import { adoptTerminal, closeTerminal } from "../terminal/api";
import { TerminalView } from "../terminal/TerminalView";
import type { TerminalPayload } from "../terminal/useTerminal";
import { matchTerminal } from "./kinds";

export const terminalViewer: PanelViewer<TerminalPayload> = {
  id: "terminal",
  match: matchTerminal,
  icon: SquareTerminal,
  title: (payload) => payloadTitle(payload) || DESKTOP_ZH.terminal,
  View: TerminalView,
  dispose: (payload) => {
    if (payload?.terminalId) void closeTerminal(payload.terminalId).catch(() => {});
  },
  move: (payload, sessionId) => {
    if (payload?.terminalId) void adoptTerminal(payload.terminalId, sessionId).catch(() => {});
  },
};
