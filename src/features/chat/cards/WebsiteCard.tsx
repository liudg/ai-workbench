import { Globe } from "lucide-react";

import { usePanelOptional } from "@/features/panel/core/PanelProvider";
import { baseName } from "@/shared/path";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { useWebsiteTitle } from "./useWebsiteTitle";

export function WebsiteCard({ href, label }: { href: string; label: string }) {
  const preview = usePanelOptional();
  const title = useWebsiteTitle(href, label || baseName(href));
  return (
    <div
      data-website-card
      className="my-2 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2"
    >
      <Globe className="h-4 w-4 shrink-0 text-zinc-300" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-zinc-100">{title}</div>
        <div className="text-xs text-zinc-500">{DESKTOP_ZH.website}</div>
      </div>
      <button
        type="button"
        data-open-with
        className="shrink-0 rounded px-2 py-1 text-xs text-zinc-100 hover:bg-zinc-800"
        onClick={() => preview?.openHref(href)}
      >
        {DESKTOP_ZH.openWith}
      </button>
    </div>
  );
}
