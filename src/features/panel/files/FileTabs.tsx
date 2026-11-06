import { Plus, X } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { baseName } from "@/shared/path";
import { cn } from "@/lib/utils";
import type { OpenFileTab } from "./open-files-place";
import { useTabContextMenu } from "../core/useTabContextMenu";

/** 预览里已打开的文件。加号再打开一个，不另起一条预览壳。 */
export function FileTabs({
  tabs,
  activePath,
  onSelect,
  onKeepOpen,
  onClose,
  onAdd,
}: {
  tabs: readonly OpenFileTab[];
  activePath: string;
  onSelect: (path: string) => void;
  onKeepOpen: (path: string) => void;
  onClose: (paths: readonly string[]) => void;
  onAdd: () => void;
}) {
  const tabMenu = useTabContextMenu(tabs.map((tab) => tab.path), onClose);
  return (
    <div
      data-file-tabs
      className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[#222] px-1.5"
    >
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        return (
          <div
            key={tab.path}
            onContextMenu={(event) => tabMenu.open(event, tab.path)}
            className={cn(
              "flex min-w-0 max-w-[180px] items-center rounded-md",
              active ? "bg-[#1c1c1c] text-[#e8e8e8]" : "text-[#8d8d8d] hover:bg-white/[0.04]",
            )}
          >
            <button
              type="button"
              data-file-tab={tab.path}
              data-active={active ? "true" : "false"}
              data-preview={tab.preview ? "true" : "false"}
              title={tab.path}
              className={cn("min-w-0 flex-1 truncate px-2 py-1 text-left text-xs", tab.preview && "italic")}
              onClick={() => onSelect(tab.path)}
              onDoubleClick={() => onKeepOpen(tab.path)}
            >
              {baseName(tab.path)}
            </button>
            <button
              type="button"
              data-file-tab-close={tab.path}
              aria-label={DESKTOP_ZH.closeTab}
              className="mr-1 rounded p-0.5 text-[#666] hover:bg-white/10 hover:text-[#e8e8e8]"
              onClick={(event) => {
                event.stopPropagation();
                onClose([tab.path]);
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        data-file-tab-add
        aria-label={DESKTOP_ZH.openAnotherFile}
        title={DESKTOP_ZH.openAnotherFile}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#8d8d8d] hover:bg-white/5 hover:text-[#e8e8e8]"
        onClick={onAdd}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {tabMenu.menu}
    </div>
  );
}
