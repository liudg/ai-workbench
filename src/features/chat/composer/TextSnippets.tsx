import { TextQuote, X } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { textSnippetChipLabel, textSnippetPreview, type TextSnippet } from "@/shared/text-snippet";

/** 浮动在作曲栏上方，展示片段正文。输入框里不放围栏。 */
export function TextSnippetPreview({ snippets }: { snippets: readonly TextSnippet[] }) {
  if (snippets.length === 0) return null;
  const shown = [...snippets].reverse();
  return (
    <div
      data-text-snippet-preview
      className="absolute bottom-full left-0 right-0 z-10 mb-2 max-h-40 space-y-2 overflow-hidden rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] px-3 py-2.5 shadow-[var(--wb-float-shadow)]"
    >
      {shown.map((snippet) => (
        <p
          key={snippet.id}
          className="whitespace-pre-wrap break-words text-[13px] leading-5 text-[var(--wb-text)]"
        >
          {textSnippetPreview(snippet.body)}
        </p>
      ))}
    </div>
  );
}

export function TextSnippetChip({
  snippets,
  onClear,
}: {
  snippets: readonly TextSnippet[];
  onClear: () => void;
}) {
  if (snippets.length === 0) return null;
  return (
    <div className="mb-2 flex min-w-0 px-1" data-text-snippets={snippets.length}>
      <div className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg border border-[var(--wb-border-strong)] bg-[var(--wb-chip)] py-1 pl-2 pr-1 text-xs text-[var(--wb-text-strong)]">
        <TextQuote className="h-3.5 w-3.5 shrink-0 text-[var(--wb-muted)]" strokeWidth={1.75} />
        <span className="min-w-0 truncate">{textSnippetChipLabel(snippets.length)}</span>
        <button
          type="button"
          data-text-snippet-remove
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--wb-muted)] hover:bg-[var(--wb-hover-strong)] hover:text-[var(--wb-text-strong)]"
          aria-label={DESKTOP_ZH.textSnippetRemove}
          onClick={(event) => {
            event.stopPropagation();
            onClear();
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
