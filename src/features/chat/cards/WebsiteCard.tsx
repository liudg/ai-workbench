import { Globe } from "lucide-react";

import { usePanelOptional } from "@/features/panel/core/PanelProvider";
import { baseName } from "@/shared/path";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { useWebsiteTitle } from "./useWebsiteTitle";

export function WebsiteCard({ href, label }: { href: string; label: string }) {
  const preview = usePanelOptional();
  const projectId = preview?.projectId ?? "";
  const title = useWebsiteTitle(projectId, href, label || baseName(href));
  return (
    <div
      data-website-card
      className="my-2 flex items-center gap-3 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-card)] px-3 py-2"
    >
      <Globe className="h-4 w-4 shrink-0 text-[var(--wb-muted)]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-[var(--wb-text-strong)]">{title}</div>
        <div className="text-xs text-[var(--wb-muted)]">{DESKTOP_ZH.website}</div>
      </div>
      <button
        type="button"
        data-open-with
        className="shrink-0 rounded-lg border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] px-2.5 py-1 text-xs font-medium text-[var(--wb-text-strong)] transition-colors hover:bg-[var(--wb-hover)]"
        onClick={() => preview?.openHref(href)}
      >
        {DESKTOP_ZH.openWith}
      </button>
    </div>
  );
}
