import { cn } from "@/lib/utils";
import type { FileChange } from "@/features/changes-model/diff-parse";
import { previewKindForPath } from "@/features/panel/core/preview-kind";
import { baseName } from "@/features/panel/files/path";
import { MarkdownBody } from "@/shared/markdown/MarkdownBody";
import { expandDiffLines, foldDiffLines, previewTextFromDiff, unmodifiedLinesLabel } from "./fold";
import { applyWordDiff, type DiffDisplayRow } from "./word-diff";

export function DiffFileSection({
  file,
  expanded,
  unified,
  wordDiff,
  renderPreview,
  source,
  active,
  onSelect,
}: {
  file: FileChange;
  expanded: boolean;
  unified: boolean;
  wordDiff: boolean;
  renderPreview: boolean;
  source: string | null;
  active: boolean;
  onSelect: () => void;
}) {
  const markdown = previewKindForPath(file.path) === "markdown";
  const folded = foldDiffLines(file.diff);
  const rows = wordDiff ? applyWordDiff(expanded ? expandDiffLines(file.diff, source) : folded) : null;
  const plain = expanded ? expandDiffLines(file.diff, source) : folded;
  return (
    <section
      className={cn("min-w-0 border-b border-zinc-800", active && "bg-zinc-950")}
      data-diff-file-body={file.path}
      onClick={onSelect}
    >
      <header className="flex min-w-0 flex-nowrap items-center gap-2 px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-zinc-300"># {baseName(file.path)}</span>
        <span className="shrink-0 whitespace-nowrap font-mono text-emerald-400">+{file.added}</span>
        <span className="shrink-0 whitespace-nowrap font-mono text-red-400">-{file.removed}</span>
      </header>
      {renderPreview && markdown ? (
        <div className="px-4 py-3">
          <MarkdownBody text={source && source.length > 0 ? source : previewTextFromDiff(file.diff)} />
        </div>
      ) : unified ? (
        <pre className="max-w-full overflow-x-hidden whitespace-pre-wrap break-all px-3 pb-3 font-mono text-xs leading-5 text-zinc-300">
          {file.diff}
        </pre>
      ) : (wordDiff ? rows : plain)?.length === 0 ? (
        <p className="px-3 py-2 text-xs text-zinc-500">没有可显示的差异文本。</p>
      ) : (
        <div className="min-w-0 pb-2 font-mono text-xs leading-5">
          {(wordDiff ? rows : plain.map((row) => (row.kind === "collapse" ? row : { ...row, parts: null })))?.map(
            (row, index) => (
              <DiffRowView key={index} row={row} />
            ),
          )}
        </div>
      )}
    </section>
  );
}

function DiffRowView({ row }: { row: DiffDisplayRow }) {
  if (row.kind === "collapse") {
    const label = unmodifiedLinesLabel(row.count);
    return (
      <div
        data-unmodified-lines={row.count}
        title={label}
        className="mx-3 my-1 truncate rounded bg-zinc-800 px-3 py-1 text-zinc-400"
      >
        {label}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex min-w-0 flex-nowrap",
        row.tone === "add" && "bg-emerald-500/15 text-emerald-200",
        row.tone === "del" && "bg-red-500/15 text-red-200",
        row.tone === "context" && "text-zinc-300",
        row.tone === "meta" && "text-zinc-500",
      )}
    >
      <span className="w-10 shrink-0 select-none px-2 text-right text-zinc-500">{row.lineNo ?? ""}</span>
      <span className="min-w-0 flex-1 overflow-hidden whitespace-pre-wrap break-all px-2">
        {row.parts && row.parts.length > 0
          ? row.parts.map((part, index) => (
              <span key={index} className={part.changed ? "rounded-sm bg-white/10" : undefined}>
                {part.text.length > 0 ? part.text : " "}
              </span>
            ))
          : row.text.length > 0
            ? row.text
            : " "}
      </span>
    </div>
  );
}
