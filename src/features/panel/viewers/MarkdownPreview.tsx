import { MarkdownBody } from "@/shared/markdown/MarkdownBody";

import { TruncatedNote } from "./TruncatedNote";

export function MarkdownPreview({ text, truncated }: { text: string; truncated: boolean }) {
  return (
    <div className="h-full overflow-auto px-4 py-3">
      {truncated ? <TruncatedNote /> : null}
      <MarkdownBody text={text} />
    </div>
  );
}
