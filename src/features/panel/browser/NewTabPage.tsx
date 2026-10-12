import { ChevronDown, File, FilePlus2, LayoutGrid, MessagesSquare, TerminalSquare } from "lucide-react";
import type { ComponentType } from "react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";

interface Tool {
  id: string;
  label: string;
  shortcut?: string;
  icon: ComponentType<{ className?: string }>;
}

const TOOLS: Tool[] = [
  { id: "file", label: DESKTOP_ZH.browserToolFile, shortcut: DESKTOP_ZH.browserToolFileShortcut, icon: File },
  {
    id: "side-chat",
    label: DESKTOP_ZH.browserToolSideChat,
    shortcut: DESKTOP_ZH.browserToolSideChatShortcut,
    icon: MessagesSquare,
  },
  {
    id: "terminal",
    label: DESKTOP_ZH.browserToolTerminal,
    shortcut: DESKTOP_ZH.browserToolTerminalShortcut,
    icon: TerminalSquare,
  },
  { id: "page", label: DESKTOP_ZH.browserToolPage, icon: FilePlus2 },
];

/** 内置浏览器空白页。工具格与官方桌面端新标签页一致。 */
export function NewTabPage() {
  return (
    <div data-new-tab-page className="h-full overflow-auto bg-zinc-950 px-6 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h3 className="text-sm font-medium text-zinc-100">{DESKTOP_ZH.browserToolsHeading}</h3>
        <div className="grid grid-cols-2 gap-3">
          {TOOLS.map((tool) => (
            <ToolButton key={tool.id} tool={tool} />
          ))}
          <button
            type="button"
            data-browser-tool="more"
            className="flex min-h-12 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 text-left text-sm text-zinc-100"
          >
            <LayoutGrid className="h-4 w-4 shrink-0 text-zinc-400" />
            <span className="min-w-0 flex-1 truncate">{DESKTOP_ZH.browserToolMore}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolButton({ tool }: { tool: Tool }) {
  const Icon = tool.icon;
  return (
    <button
      type="button"
      data-browser-tool={tool.id}
      className="flex min-h-12 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 text-left text-sm text-zinc-100"
    >
      <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
      <span className="min-w-0 flex-1 truncate">{tool.label}</span>
      {tool.shortcut ? (
        <kbd className="shrink-0 rounded-md bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">{tool.shortcut}</kbd>
      ) : null}
    </button>
  );
}
