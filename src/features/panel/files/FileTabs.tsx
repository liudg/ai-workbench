import { Plus, X } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { baseName } from "@/shared/path";
import { cn } from "@/lib/utils";
import type { OpenFileTab } from "./open-files-place";

/** 预览里已打开的文件。加号再打开一个，不另起一条预览壳。 */
export function FileTabs({
  tabs,
  activePath,
  onSelect,
  onClose,
  onAdd,
}: {
  tabs: readonly OpenFileTab[];
  activePath: string;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onAdd: () => void;
}) {
  return (
    <div
      data-file-tabs
      className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--wb-border)] bg-[var(--wb-canvas)] px-1.5"
    >
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        return (
          <div
            key={tab.path}
            className={cn(
              "flex min-w-0 max-w-[180px] items-center rounded-md transition-colors",
              active
                ? "bg-[var(--wb-chip)] font-medium text-[var(--wb-text-strong)]"
                : "text-[var(--wb-muted)] hover:bg-[var(--wb-hover)]",
            )}
          >
            <button
              type="button"
              data-file-tab={tab.path}
              data-active={active ? "true" : "false"}
              title={tab.path}
              className="min-w-0 flex-1 truncate px-2 py-1 text-left text-xs"
              onClick={() => onSelect(tab.path)}
            >
              {baseName(tab.path)}
            </button>
            <button
              type="button"
              data-file-tab-close={tab.path}
              aria-label={DESKTOP_ZH.closeTab}
              className="mr-1 rounded p-0.5 text-[var(--wb-faint)] hover:bg-[var(--wb-hover-strong)] hover:text-[var(--wb-text-strong)]"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.path);
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
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--wb-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]"
        onClick={onAdd}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
