import { useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, Clipboard, FileText, Image as ImageIcon, Import as ImportIcon, Pilcrow, WholeWord } from "lucide-react";

import { cn } from "@/lib/utils";
import { diffMenuEntries, type DiffMenuIcon } from "./diff-menu";
import { useAnchoredLayer } from "../core/useAnchoredLayer";

function MenuGlyph({ icon }: { icon: DiffMenuIcon }) {
  const className = "h-3.5 w-3.5 shrink-0";
  if (icon === "file") return <FileText className={className} />;
  if (icon === "preview") return <ImageIcon className={className} />;
  if (icon === "word") return <WholeWord className={className} />;
  if (icon === "space") return <Pilcrow className={className} />;
  if (icon === "imports") return <ImportIcon className={className} />;
  return <Clipboard className={className} />;
}

export function OptionsMenu({
  anchorRef,
  entries,
  checked,
  onRun,
  onCopy,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  entries: ReturnType<typeof diffMenuEntries>;
  checked: Record<string, boolean>;
  onRun: (id: string) => void;
  onCopy: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useAnchoredLayer(true, anchorRef, menuRef, entries.map((entry) => entry.kind).join(","));
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-diff-options-menu
      className="fixed z-[80] w-max min-w-[232px] rounded-xl border border-[#2a2a2a] bg-[#1b1b1b] py-1 text-[#e8e8e8] shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
    >
      {entries.map((entry) => (
        <span key={entry.id} className="block" title={entry.kind === "disabled" ? entry.reason : undefined}>
          <button
            type="button"
            role={entry.kind === "check" ? "menuitemcheckbox" : "menuitem"}
            aria-checked={entry.kind === "check" ? Boolean(checked[entry.id]) : undefined}
            disabled={entry.kind === "disabled"}
            aria-disabled={entry.kind === "disabled" || undefined}
            aria-label={
              entry.kind === "disabled" && entry.reason ? `${entry.label}（${entry.reason}）` : entry.label
            }
            data-diff-option={entry.label}
            data-diff-copy-apply={entry.id === "copy-apply" ? "" : undefined}
            data-diff-copy-enabled={entry.id === "copy-apply" ? String(entry.kind === "action") : undefined}
            data-diff-copy-reason={entry.id === "copy-apply" ? entry.reason ?? "" : undefined}
            className={cn(
              "flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-[13px]",
              entry.kind === "disabled"
                ? "pointer-events-none cursor-default text-[#666]"
                : "text-[#e8e8e8] hover:bg-white/5",
            )}
            onClick={() => {
              if (entry.kind === "disabled") return;
              if (entry.id === "copy-apply") onCopy();
              else onRun(entry.id);
            }}
          >
            <MenuGlyph icon={entry.icon} />
            <span className="min-w-0 flex-1">{entry.label}</span>
            {entry.kind === "check" && checked[entry.id] ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-[#cfcfcf]" />
            ) : (
              <span className="h-3.5 w-3.5 shrink-0" />
            )}
          </button>
        </span>
      ))}
    </div>,
    document.body,
  );
}

