import { File } from "lucide-react";
import type { ComponentType } from "react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { usePanel } from "../core/PanelProvider";

interface Tool {
  id: string;
  label: string;
  shortcut?: string;
  icon: ComponentType<{ className?: string }>;
}

const FILE_TOOL: Tool = {
  id: "file",
  label: DESKTOP_ZH.browserToolFile,
  shortcut: DESKTOP_ZH.browserToolFileShortcut,
  icon: File,
};

/** 内置浏览器空白页。只留已接通的「文件」。 */
export function NewTabPage() {
  const { openFiles } = usePanel();
  const Icon = FILE_TOOL.icon;
  return (
    <div data-new-tab-page className="h-full overflow-auto bg-zinc-950 px-6 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-zinc-100">{DESKTOP_ZH.browserToolsHeading}</h3>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              data-browser-tool={FILE_TOOL.id}
              className="flex min-h-12 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 text-left text-sm text-zinc-100 hover:bg-zinc-800"
              onClick={openFiles}
            >
              <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
              <span className="min-w-0 flex-1 truncate">{FILE_TOOL.label}</span>
              <kbd className="shrink-0 rounded-md bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">
                {FILE_TOOL.shortcut}
              </kbd>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
