import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTitlebarUpdatePill } from "./use-updates";

export function UpdateTitlebarPill() {
  const { pill, openDialog } = useTitlebarUpdatePill();
  if (!pill) return null;

  return (
    <button
      type="button"
      data-update-pill={pill.kind}
      onClick={openDialog}
      className={cn(
        "mr-1.5 inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium leading-4 transition-colors",
        pill.kind === "available" &&
          "bg-wb-accent-soft text-wb-accent-ink hover:brightness-110",
        pill.kind === "downloading" &&
          "border border-wb-border-strong bg-wb-elev tabular-nums text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
        (pill.kind === "downloaded" || pill.kind === "ready") &&
          "bg-wb-accent text-white hover:opacity-90",
        pill.kind === "error" &&
          "bg-wb-warn-soft text-wb-warn hover:brightness-110",
      )}
    >
      {pill.kind === "available" && (
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-wb-accent" />
      )}
      {pill.kind === "downloading" && (
        <Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin text-wb-accent" />
      )}
      {pill.kind === "error" && (
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-wb-warn" />
      )}
      <span>{pill.label}</span>
    </button>
  );
}
