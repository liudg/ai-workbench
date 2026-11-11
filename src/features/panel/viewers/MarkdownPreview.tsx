import { MarkdownBody } from "@/shared/markdown/MarkdownBody";

import { TruncatedNote } from "./TruncatedNote";

export function MarkdownPreview({ text, truncated }: { text: string; truncated: boolean }) {
  return (
    <div className="h-full min-w-0 select-text overflow-x-hidden overflow-y-auto bg-[var(--wb-diff-well)] px-5 py-4">
      {truncated ? <TruncatedNote /> : null}
      <MarkdownBody text={text} />
    </div>
  );
}
