import { sourceLines } from "../core/source-lines";
import { highlightLine } from "./highlight";
import { TruncatedNote } from "./TruncatedNote";

export function TextPreview({ text, truncated }: { text: string; truncated: boolean }) {
  const lines = sourceLines(text);
  return (
    <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto bg-[var(--wb-diff-well)] font-mono text-[12.5px] leading-5">
      {truncated ? <TruncatedNote /> : null}
      {lines.map((line, index) => (
        <div key={index} data-source-line={index + 1} className="flex min-w-0">
          <span className="min-w-10 shrink-0 select-none bg-[var(--wb-gutter)] px-2 text-right tabular-nums text-[var(--wb-faint)]">{index + 1}</span>
          <span className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words px-2 text-[var(--wb-text-strong)]">
            {line ? (
              highlightLine(line).map((token, tokenIndex) => (
                <span key={tokenIndex} className={`tok-${token.kind}`}>
                  {token.text}
                </span>
              ))
            ) : (
              " "
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
