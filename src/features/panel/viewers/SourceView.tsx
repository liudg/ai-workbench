import { Fragment, useEffect, useRef } from "react";

import type { TextSnippetDraft } from "@/shared/text-snippet";
import { sourceLines } from "../core/source-lines";
import { cn } from "@/lib/utils";
import { highlightLine } from "./highlight";
import {
  boxBelow,
  commentRowProps,
  CommentPlus,
  LineCommentBox,
  SavedComment,
  spanCovers,
  type LineComments,
  type SavedComments,
} from "./line-comments";
import { selectionDraft } from "./selection-quote";
import { TruncatedNote } from "./TruncatedNote";

/** 源码视图里只有一份文件，行序号就是行号减一。 */
export const SOURCE_SCOPE = "source";

interface SourceComments {
  path: string;
  comments: LineComments;
  /** 写好还没发的评论，留在行下面。 */
  saved: SavedComments | null;
  onAdd: (draft: TextSnippetDraft) => void;
}

/** 带行号的源码。给了 line 就滚到那一行并标出来；给了 comment 就能按行评论。 */
export function SourceView({
  text,
  line = null,
  truncated = false,
  comment = null,
}: {
  text: string;
  line?: number | null;
  truncated?: boolean;
  comment?: SourceComments | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const lines = sourceLines(text);
  useEffect(() => {
    if (line == null) return;
    scroller.current
      ?.querySelector(`[data-source-line="${line}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [line, text]);
  const comments = comment?.comments ?? null;
  const span = comments?.editing ? comments.span : null;
  const boxDraft =
    comment && span
      ? (comments?.draft ??
        selectionDraft(comment.path, lines.slice(span.start, span.end + 1).join("\n"), span.start + 1, span.end + 1))
      : null;
  return (
    <div ref={scroller} className="h-full min-w-0 overflow-x-hidden overflow-y-auto bg-wb-panel font-mono text-[12.5px] leading-5">
      {truncated ? <TruncatedNote /> : null}
      {lines.map((content, index) => {
        const number = index + 1;
        const picked = spanCovers(comments, SOURCE_SCOPE, index);
        return (
          <Fragment key={number}>
            <div
              data-source-line={number}
              {...(comments ? commentRowProps(SOURCE_SCOPE, index) : {})}
              className={cn(
                "group relative flex min-w-0",
                number === line && "bg-[var(--wb-line-focus-bg)]",
                picked && "bg-[var(--wb-line-pick-bg)]",
              )}
            >
              {comments ? <CommentPlus scope={SOURCE_SCOPE} row={index} comments={comments} className="left-1" /> : null}
              <span className="w-10 shrink-0 select-none px-2 text-right tabular-nums text-wb-fg-3">{number}</span>
              <span className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words px-2">
                <HighlightedText text={content} />
              </span>
            </div>
            {comment?.saved?.byLine.get(number)?.map((snippet) => (
              <SavedComment key={snippet.id} snippet={snippet} onRemove={() => comment.saved?.remove(snippet.id)} />
            ))}
            {comment && comments && span && boxDraft && boxBelow(comments, SOURCE_SCOPE, index) ? (
              <LineCommentBox
                key={`${span.start}:${span.end}`}
                draft={boxDraft}
                onSubmit={(draft) => {
                  comment.onAdd(draft);
                  comments.close();
                }}
                onCancel={comments.close}
              />
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

function HighlightedText({ text }: { text: string }) {
  if (!text) return <span className="tok-plain"> </span>;
  return (
    <>
      {highlightLine(text).map((token, index) => (
        <span key={index} className={`tok-${token.kind}`}>
          {token.text}
        </span>
      ))}
    </>
  );
}
