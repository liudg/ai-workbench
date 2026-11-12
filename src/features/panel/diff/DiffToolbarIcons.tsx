import type { ReactNode } from "react";
import { Expand, Folder, RotateCw, WrapText } from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { DiffToolbarIconId } from "./toolbar-actions";
import { SplitDiffIcon } from "./toolbar-icons";

export function iconLabel(
  id: Exclude<DiffToolbarIconId, "options" | "jump">,
  state: { layoutSplit: boolean; filesOpen: boolean },
): string {
  if (id === "refresh") return DESKTOP_ZH.diffRefresh;
  if (id === "wrap") return DESKTOP_ZH.diffWrap;
  if (id === "expand") return DESKTOP_ZH.diffExpand;
  if (id === "layout") return state.layoutSplit ? DESKTOP_ZH.diffUnified : DESKTOP_ZH.diffSplit;
  return state.filesOpen ? DESKTOP_ZH.diffHideFile : DESKTOP_ZH.diffShowFile;
}

export function iconPressed(
  id: Exclude<DiffToolbarIconId, "options" | "jump">,
  state: { wrap: boolean; expanded: boolean; layoutSplit: boolean; filesOpen: boolean },
): boolean {
  if (id === "wrap") return state.wrap;
  if (id === "expand") return state.expanded;
  if (id === "layout") return state.layoutSplit;
  if (id === "files") return state.filesOpen;
  return false;
}

export function ToolbarGlyph({ id }: { id: Exclude<DiffToolbarIconId, "options" | "jump"> }) {
  if (id === "refresh") return <RotateCw className="h-3.5 w-3.5" />;
  if (id === "wrap") return <WrapText className="h-3.5 w-3.5" />;
  if (id === "expand") return <Expand className="h-3.5 w-3.5" />;
  if (id === "layout") return <SplitDiffIcon />;
  return <Folder className="h-3.5 w-3.5" />;
}

export function IconButton({
  id,
  label,
  pressed,
  expanded,
  menu,
  onClick,
  children,
}: {
  id: DiffToolbarIconId;
  label: string;
  pressed?: boolean;
  expanded?: boolean;
  menu?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-diff-action={id}
      data-diff-options={id === "options" ? "" : undefined}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-haspopup={menu ? "menu" : undefined}
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
        pressed || expanded
          ? "bg-wb-active text-wb-fg"
          : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

