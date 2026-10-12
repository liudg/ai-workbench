import { ChevronDown, File, FilePlus2, LayoutGrid, MessagesSquare, TerminalSquare } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { usePanel } from "../core/PanelProvider";

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

/** 内置浏览器空白页。点「文件」进入打开文件；其余磁贴视频里没有点开。 */
export function NewTabPage() {
  const { openFiles } = usePanel();
  return (
    <div data-new-tab-page className="h-full overflow-auto bg-zinc-950 px-6 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-zinc-100">{DESKTOP_ZH.browserToolsHeading}</h3>
          <div className="grid grid-cols-2 gap-3">
            {TOOLS.map((tool) => (
              <ToolButton key={tool.id} tool={tool} onClick={tool.id === "file" ? openFiles : undefined} />
            ))}
            <button
              type="button"
              data-browser-tool="more"
              className="col-span-2 flex min-h-12 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 text-left text-sm text-zinc-100 hover:bg-zinc-800"
            >
              <LayoutGrid className="h-4 w-4 shrink-0 text-zinc-400" />
              <span className="min-w-0 flex-1 truncate">{DESKTOP_ZH.browserToolMore}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            </button>
          </div>
        </section>
        <section className="flex flex-col gap-2" data-browser-recommend-list>
          <h3 className="text-sm font-medium text-zinc-100">{DESKTOP_ZH.recommendHeading}</h3>
          <RecommendRow id="dungeon" icon={<GlobeMark />} label={DESKTOP_ZH.recommendDungeon} />
          <RecommendRow id="figma" icon={<FigmaMark />} label={DESKTOP_ZH.recommendFigma} />
          <RecommendRow id="github" icon={<GitHubMark />} label={DESKTOP_ZH.recommendGithub} />
        </section>
      </div>
    </div>
  );
}

function ToolButton({ tool, onClick }: { tool: Tool; onClick?: () => void }) {
  const Icon = tool.icon;
  return (
    <button
      type="button"
      data-browser-tool={tool.id}
      className="flex min-h-12 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 text-left text-sm text-zinc-100 hover:bg-zinc-800"
      onClick={onClick}
    >
      <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
      <span className="min-w-0 flex-1 truncate">{tool.label}</span>
      {tool.shortcut ? (
        <kbd className="shrink-0 rounded-md bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">{tool.shortcut}</kbd>
      ) : null}
    </button>
  );
}

function RecommendRow({ id, icon, label }: { id: string; icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      data-browser-recommend={id}
      className="flex min-h-11 items-center gap-2 rounded-xl px-2 text-left text-sm text-zinc-100 hover:bg-zinc-900"
    >
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function GlobeMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 text-zinc-300" aria-hidden="true">
      <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.8 8h10.4M8 2.8c1.6 1.6 1.6 8.8 0 10.4M8 2.8c-1.6 1.6-1.6 8.8 0 10.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function FigmaMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
      <path d="M6 2.2h2.2a1.8 1.8 0 0 1 0 3.6H6V2.2Z" fill="#f24e1e" />
      <path d="M6 5.8h2.2a1.8 1.8 0 0 1 0 3.6H6V5.8Z" fill="#a259ff" />
      <path d="M6 9.4h2.2a1.8 1.8 0 1 1-1.8 1.8V9.4H6Z" fill="#1abcfe" />
      <path d="M8.2 2.2H10a1.8 1.8 0 0 1 0 3.6H8.2V2.2Z" fill="#ff7262" />
      <circle cx="10" cy="7.6" r="1.8" fill="#0acf83" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 text-zinc-100" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 1.6a6.4 6.4 0 0 0-2 12.46c.32.06.44-.14.44-.3v-1.06c-1.78.38-2.16-.86-2.16-.86-.28-.74-.7-.94-.7-.94-.58-.4.04-.4.04-.4.64.04.98.66.98.66.56.98 1.48.7 1.84.54.06-.42.22-.7.4-.86-1.42-.16-2.92-.72-2.92-3.18 0-.7.24-1.28.66-1.72-.06-.16-.28-.82.06-1.72 0 0 .54-.18 1.76.66a6 6 0 0 1 3.2 0c1.22-.84 1.76-.66 1.76-.66.34.9.12 1.56.06 1.72.42.44.66 1.02.66 1.72 0 2.46-1.5 3.02-2.94 3.18.24.2.44.6.44 1.22v1.8c0 .16.12.36.44.3A6.4 6.4 0 0 0 8 1.6Z"
      />
    </svg>
  );
}
