import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import type { FileChange } from "@/features/changes-model/diff-parse";
import { previewKindForPath } from "@/features/panel/core/preview-kind";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { MarkdownBody } from "@/shared/markdown/MarkdownBody";
import { diffBodyRows } from "./diff-body";
import { foldDiffLines, previewTextFromDiff, unmodifiedLinesLabel } from "./fold";
import { toSplitRows, type DiffPresentation, type SplitCell } from "./split-rows";
import { applyWordDiff, type DiffDisplayRow, type WordPart } from "./word-diff";

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
      onClick={onSelect}
    >
      <header className="flex min-w-0 flex-nowrap items-center gap-2 px-3 py-2 text-xs" data-diff-summary={file.path}>
        <button
          type="button"
          data-diff-toggle={file.path}
          aria-expanded={open}
          aria-label={open ? "收起差异" : "展开差异"}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#888] hover:bg-white/5 hover:text-[#e8e8e8]"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
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
        ) : presentation === "split" ? (
          <SplitBody rows={rows} wrap={wrap} />
        ) : (
          <div className="min-w-0 pb-2 font-mono text-xs leading-5">
            {rows.map((row, index) => (
              <DiffRowView key={index} row={row} wrap={wrap} />
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

function SplitBody({ rows, wrap }: { rows: DiffDisplayRow[]; wrap: boolean }) {
  return (
    <div className="min-w-0 pb-2 font-mono text-xs leading-5" data-diff-split-body>
      {toSplitRows(rows).map((row, index) =>
        row.kind === "collapse" ? (
          <CollapseBar key={index} count={row.count} />
        ) : (
          <div key={index} className={cn("grid grid-cols-2", wrap ? "min-w-0" : "min-w-max")}>
            <SplitCellView cell={row.left} wrap={wrap} edge="left" />
            <SplitCellView cell={row.right} wrap={wrap} edge="right" />
          </div>
        ),
      )}
    </div>
  );
}

function SplitCellView({ cell, wrap, edge }: { cell: SplitCell; wrap: boolean; edge: "left" | "right" }) {
  return (
    <div
      data-diff-split-cell={edge}
      data-diff-tone={cell.tone}
      className={cn(
        "flex min-w-0",
        edge === "left" && "border-r border-[#222]",
        cell.tone === "add" && "bg-[#173324] text-[#b7ebc6]",
        cell.tone === "del" && "bg-[#3a1f24] text-[#f0b4b4]",
        cell.tone === "context" && "text-[#d4d4d4]",
        cell.tone === "meta" && "text-zinc-500",
        cell.tone === "pad" && "bg-zinc-950/30",
      )}
    >
      <span className="w-10 shrink-0 select-none px-2 text-right text-zinc-500">{cell.lineNo ?? ""}</span>
      <LineText text={cell.text} parts={cell.parts} wrap={wrap} />
    </div>
  );
}

function DiffRowView({ row, wrap }: { row: DiffDisplayRow; wrap: boolean }) {
  if (row.kind === "collapse") return <CollapseBar count={row.count} />;
  return (
    <div
      data-diff-tone={row.tone}
      className={cn(
        "flex min-w-0 flex-nowrap",
        row.tone === "add" && "bg-[#173324] text-[#b7ebc6]",
        row.tone === "del" && "bg-[#3a1f24] text-[#f0b4b4]",
        row.tone === "context" && "text-[#d4d4d4]",
        row.tone === "meta" && "text-zinc-500",
      )}
    >
      <span className="w-10 shrink-0 select-none px-2 text-right text-zinc-500">{row.lineNo ?? ""}</span>
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
