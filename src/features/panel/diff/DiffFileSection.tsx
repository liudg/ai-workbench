import { Fragment, useLayoutEffect, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import type { FileChange } from "@/features/changes-model/diff-parse";
import { previewKindForPath } from "@/features/panel/core/preview-kind";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { MarkdownBody } from "@/shared/markdown/MarkdownBody";
import type { TextSnippetDraft } from "@/shared/text-snippet";
import {
  boxBelow,
  commentRowOf,
  commentRowProps,
  CommentPlus,
  LineCommentBox,
  spanCovers,
  type LineComments,
} from "../viewers/line-comments";
import { diffBodyRows } from "./diff-body";
import { canCommentLine, diffCommentScope, diffSpanDraft, type DiffCommentLine } from "./diff-comments";
import { foldDiffLines, previewTextFromDiff, unmodifiedLinesLabel } from "./fold";
import { toSplitRows, type DiffPresentation, type SplitCell } from "./split-rows";
import { applyWordDiff, type DiffDisplayRow, type WordPart } from "./word-diff";
import { diffFileDisclosureClass } from "./diff-disclosure";

/** 按 scope 取几行的引用。选区和右键都用它，引用总是整行、只取一栏。 */
export type SpanDrafts = Map<string, (start: number, end: number) => TextSnippetDraft | null>;

interface DiffComments {
  comments: LineComments;
  /** 引用里写的路径，一般是绝对路径。 */
  quotePath: string;
  onAdd: (draft: TextSnippetDraft) => void;
  spans: SpanDrafts;
}

/** 右键点中的那一行。 */
export interface DiffLineHit {
  scope: string;
  row: number;
  draft: TextSnippetDraft | null;
}

const PICKED = "shadow-[inset_3px_0_0_#2f81f7]";

export function DiffFileSection({
  file,
  open,
  onToggle,
  presentation,
  wrap,
  wordDiff,
  renderPreview,
  source,
  hideImports,
  hideWhitespace,
  loadFull,
  active,
  onSelect,
  onActivate,
  comment,
  onLineMenu,
}: {
  file: FileChange;
  open: boolean;
  onToggle: () => void;
  presentation: DiffPresentation;
  wrap: boolean;
  wordDiff: boolean;
  renderPreview: boolean;
  source: string | null;
  hideImports: boolean;
  hideWhitespace: boolean;
  loadFull: boolean;
  active: boolean;
  onSelect: () => void;
  onActivate: () => void;
  comment: DiffComments;
  onLineMenu: (event: ReactMouseEvent, hit: DiffLineHit) => void;
}) {
  const markdown = previewKindForPath(file.path) === "markdown";
  const display = diffBodyRows({
    diff: file.diff,
    status: file.status,
    added: file.added,
    removed: file.removed,
    source,
    loadFull,
    hideWhitespace,
    hideImports,
  });
  const rows = wordDiff ? applyWordDiff(display.rows) : display.rows.map(withEmptyParts);
  const split = presentation === "split" ? toSplitRows(rows) : null;
  const unifiedScope = diffCommentScope(file.path, "unified");
  const leftScope = diffCommentScope(file.path, "left");
  const rightScope = diffCommentScope(file.path, "right");
  const linesFor = (scope: string): (DiffCommentLine | null)[] => {
    if (scope === unifiedScope) return rows.map((row) => (row.kind === "collapse" ? null : row));
    if (!split) return [];
    if (scope === leftScope) return split.map((row) => (row.kind === "pair" ? row.left : null));
    if (scope === rightScope) return split.map((row) => (row.kind === "pair" ? row.right : null));
    return [];
  };
  const spanDraft = (scope: string, start: number, end: number) =>
    diffSpanDraft(linesFor(scope), start, end, comment.quotePath);
  const { comments, spans } = comment;
  useLayoutEffect(() => {
    const scopes = split ? [leftScope, rightScope] : [unifiedScope];
    for (const scope of scopes) spans.set(scope, (start, end) => spanDraft(scope, start, end));
    return () => {
      for (const scope of scopes) spans.delete(scope);
    };
  });
  const openSpan = comments.editing && comments.span ? comments.span : null;
  const mine = openSpan && [unifiedScope, leftScope, rightScope].includes(openSpan.scope) ? openSpan : null;
  const boxDraft = mine ? (comments.draft ?? spanDraft(mine.scope, mine.start, mine.end)) : null;
  const box =
    mine && boxDraft ? (
      <LineCommentBox
        key={`${mine.scope}:${mine.start}:${mine.end}`}
        draft={boxDraft}
        onSubmit={(draft) => {
          comment.onAdd(draft);
          comments.close();
        }}
        onCancel={comments.close}
      />
    ) : null;
  const rowMenu = (event: ReactMouseEvent) => {
    const hit = commentRowOf(event.target instanceof Node ? event.target : null);
    if (!hit) return;
    event.stopPropagation();
    onLineMenu(event, { ...hit, draft: spanDraft(hit.scope, hit.row, hit.row) });
  };
  return (
    <section
      className={cn(
        "min-w-0 scroll-mt-2 border-b border-[#222]",
        active && "bg-[#121212]",
      )}
      data-diff-file-body={file.path}
      data-diff-open={open ? "true" : "false"}
      data-diff-active={active ? "true" : "false"}
      data-diff-presentation={presentation}
      onClick={onActivate}
      onContextMenu={rowMenu}
    >
      <header
        className="flex min-w-0 cursor-pointer flex-nowrap items-center gap-2 px-3 py-2 text-xs"
        data-diff-summary={file.path}
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
          onToggle();
        }}
      >
        <button
          type="button"
          data-diff-toggle={file.path}
          aria-expanded={open}
          aria-label={open ? "收起差异" : "展开差异"}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#888] hover:bg-white/5 hover:text-[#e8e8e8]"
        >
          <ChevronRight
            data-diff-disclosure={diffFileDisclosureClass(open)}
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-150",
              diffFileDisclosureClass(open),
            )}
          />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#cfcfcf]" title={file.path}>
          {file.path}
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono text-[12px] text-[#3fb950]">+{file.added}</span>
        <span className="shrink-0 whitespace-nowrap font-mono text-[12px] text-[#f85149]">-{file.removed}</span>
      </header>
      {open ? (
        renderPreview && markdown ? (
          <div className="px-4 py-3">
            <MarkdownBody text={source && source.length > 0 ? source : previewTextFromDiff(file.diff)} />
          </div>
        ) : display.whitespaceHidden ? (
          <p className="px-3 py-2 text-xs text-zinc-500" data-diff-whitespace-hidden>
            {DESKTOP_ZH.diffWhitespaceHidden}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-zinc-500">没有可显示的差异文本。</p>
        ) : split ? (
          <div className="min-w-0 pb-2 font-mono text-xs leading-5" data-diff-split-body>
            {split.map((row, index) =>
              row.kind === "collapse" ? (
                <CollapseBar key={index} count={row.count} />
              ) : (
                <Fragment key={index}>
                  <div className={cn("grid grid-cols-2", wrap ? "min-w-0" : "min-w-max")}>
                    <SplitCellView cell={row.left} wrap={wrap} edge="left" scope={leftScope} row={index} comments={comments} />
                    <SplitCellView cell={row.right} wrap={wrap} edge="right" scope={rightScope} row={index} comments={comments} />
                  </div>
                  {boxBelow(comments, leftScope, index) || boxBelow(comments, rightScope, index) ? box : null}
                </Fragment>
              ),
            )}
          </div>
        ) : (
          <div className="min-w-0 pb-2 font-mono text-xs leading-5">
            {rows.map((row, index) => (
              <Fragment key={index}>
                <DiffRowView row={row} wrap={wrap} scope={unifiedScope} index={index} comments={comments} />
                {boxBelow(comments, unifiedScope, index) ? box : null}
              </Fragment>
            ))}
          </div>
        )
      ) : null}
    </section>
  );
}

function withEmptyParts(row: ReturnType<typeof foldDiffLines>[number]): DiffDisplayRow {
  if (row.kind === "collapse") return row;
  return { ...row, parts: null };
}

function SplitCellView({
  cell,
  wrap,
  edge,
  scope,
  row,
  comments,
}: {
  cell: SplitCell;
  wrap: boolean;
  edge: "left" | "right";
  scope: string;
  row: number;
  comments: LineComments;
}) {
  const commentable = canCommentLine(cell);
  return (
    <div
      data-diff-split-cell={edge}
      data-diff-tone={cell.tone}
      {...(commentable ? commentRowProps(scope, row) : {})}
      className={cn(
        "group relative flex min-w-0",
        edge === "left" && "border-r border-[#222]",
        cell.tone === "add" && "bg-[#173324] text-[#b7ebc6]",
        cell.tone === "del" && "bg-[#3a1f24] text-[#f0b4b4]",
        cell.tone === "context" && "text-[#d4d4d4]",
        cell.tone === "meta" && "text-zinc-500",
        cell.tone === "pad" && "bg-zinc-950/30",
        spanCovers(comments, scope, row) && PICKED,
      )}
    >
      {commentable ? <CommentPlus scope={scope} row={row} comments={comments} className="left-0.5" /> : null}
      <span className="w-10 shrink-0 select-none px-2 text-right text-zinc-500">{cell.lineNo ?? ""}</span>
      <LineText text={cell.text} parts={cell.parts} wrap={wrap} />
    </div>
  );
}

function DiffRowView({
  row,
  wrap,
  scope,
  index,
  comments,
}: {
  row: DiffDisplayRow;
  wrap: boolean;
  scope: string;
  index: number;
  comments: LineComments;
}) {
  if (row.kind === "collapse") return <CollapseBar count={row.count} />;
  const commentable = canCommentLine(row);
  return (
    <div
      data-diff-tone={row.tone}
      {...(commentable ? commentRowProps(scope, index) : {})}
      className={cn(
        "group relative flex min-w-0 flex-nowrap",
        row.tone === "add" && "bg-[#173324] text-[#b7ebc6]",
        row.tone === "del" && "bg-[#3a1f24] text-[#f0b4b4]",
        row.tone === "context" && "text-[#d4d4d4]",
        row.tone === "meta" && "text-zinc-500",
        spanCovers(comments, scope, index) && PICKED,
      )}
    >
      {commentable ? <CommentPlus scope={scope} row={index} comments={comments} className="left-0.5" /> : null}
      <span data-diff-old-line className="w-9 shrink-0 select-none px-1 text-right text-[#6a6a6a]">
        {row.oldNo ?? ""}
      </span>
      <span data-diff-new-line className="w-9 shrink-0 select-none px-1 text-right text-[#6a6a6a]">
        {row.newNo ?? ""}
      </span>
      <span data-diff-sign className="w-4 shrink-0 select-none text-center text-[#8a8a8a]">
        {row.tone === "add" ? "+" : row.tone === "del" ? "-" : ""}
      </span>
      <LineText text={row.text} parts={row.parts} wrap={wrap} />
    </div>
  );
}

function CollapseBar({ count }: { count: number }) {
  const label = unmodifiedLinesLabel(count);
  return (
    <div
      data-unmodified-lines={count}
      title={label}
      className="mx-3 my-1 truncate rounded bg-zinc-800 px-3 py-1 text-zinc-400"
    >
      {label}
    </div>
  );
}

function LineText({ text, parts, wrap }: { text: string; parts: WordPart[] | null; wrap: boolean }) {
  return (
    <span
      className={cn(
        "min-w-0 flex-1 px-2",
        wrap ? "overflow-hidden whitespace-pre-wrap break-all" : "overflow-x-auto whitespace-pre",
      )}
    >
      {parts && parts.length > 0
        ? parts.map((part, index) => (
            <span key={index} className={part.changed ? "rounded-sm bg-white/10" : undefined}>
              {part.text.length > 0 ? part.text : " "}
            </span>
          ))
        : text.length > 0
          ? text
          : " "}
    </span>
  );
}
