import { Globe } from "lucide-react";

import { usePanelOptional } from "@/features/panel";
import { baseName } from "@/shared/path";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { useWebsiteTitle } from "./useWebsiteTitle";

export function WebsiteCard({ href, label }: { href: string; label: string }) {
  const preview = usePanelOptional();
  const title = useWebsiteTitle(href, label || baseName(href));
  return (
    <div
      data-website-card
      className="my-2 flex items-center gap-3 rounded-xl border border-wb-border bg-wb-card px-3.5 py-2.5"
    >
      <Globe className="h-4 w-4 shrink-0 text-wb-fg-2" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-wb-fg">{title}</div>
        <div className="text-xs text-wb-fg-3">{DESKTOP_ZH.website}</div>
      </div>
      {preview ? (
        <button
          type="button"
          data-open-with
          className="shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
          onClick={() => preview.openHref(href)}
        >
          {DESKTOP_ZH.openWith}
        </button>
      ) : null}
    </div>
  );
}
