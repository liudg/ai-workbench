import { Fragment } from "react";

import { cn } from "../../lib/utils.ts";
import { parseSnippetSegments } from "./snippet.ts";

export function HighlightedSnippet({
  snippet,
  query,
  className,
  markClassName,
}: {
  snippet: string;
  query: string;
  className?: string;
  markClassName?: string;
}) {
  const segments = parseSnippetSegments(snippet, query);
  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.highlight ? (
          <mark
            key={index}
            className={cn(
              "rounded-[3px] bg-wb-accent-soft px-0.5 font-medium text-wb-fg underline decoration-wb-accent/70 underline-offset-2",
              markClassName,
            )}
          >
            {segment.text}
          </mark>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </span>
  );
}
