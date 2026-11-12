import { X } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { textSnippetBadge, textSnippetPreview, type TextSnippet } from "@/shared/text-snippet";

/** 作曲栏里的引用卡片：评论显示评论的话，其它显示摘出来的原文。悬停出现移除。 */
export function TextSnippetCards({
  snippets,
  onRemove,
}: {
  snippets: readonly TextSnippet[];
  onRemove: (id: string) => void;
}) {
  if (snippets.length === 0) return null;
  return (
    <div className="mb-2 flex min-w-0 flex-wrap gap-2 px-1 pr-1.5 pt-1.5" data-text-snippets={snippets.length}>
      {snippets.map((snippet) => (
        <div
          key={snippet.id}
          data-text-snippet={snippet.id}
          title={snippet.note ? `${snippet.note}\n\n${snippet.body}` : snippet.body}
          className="group relative flex h-[84px] w-[120px] shrink-0 flex-col rounded-xl border border-wb-border bg-wb-surface p-2"
        >
          <p className="line-clamp-3 whitespace-pre-wrap break-words border-l-2 border-wb-border-strong pl-1.5 text-[11px] leading-4 text-wb-fg-2">
            {textSnippetPreview(snippet.note ?? snippet.body)}
          </p>
          <span className="mt-auto max-w-full self-start truncate rounded-md border border-wb-border px-1.5 text-[10px] leading-4 text-wb-fg-3">
            {textSnippetBadge(snippet)}
          </span>
          <button
            type="button"
            data-text-snippet-remove
            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-wb-border-strong bg-wb-popover text-wb-fg-2 opacity-0 shadow-xs transition-opacity hover:text-wb-fg group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={DESKTOP_ZH.textSnippetRemove}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(snippet.id);
            }}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
