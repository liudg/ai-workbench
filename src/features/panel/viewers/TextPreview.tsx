import { highlightLine } from "./highlight";
import { TruncatedNote } from "./TruncatedNote";

export function TextPreview({ text, truncated }: { text: string; truncated: boolean }) {
  const lines = text.split(/\r?\n/);
  return (
    <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto bg-[#0f0f0f] font-mono text-[12.5px] leading-5">
      {truncated ? <TruncatedNote /> : null}
      {lines.map((line, index) => (
        <div key={index} data-source-line={index + 1} className="flex min-w-0">
          <span className="w-10 shrink-0 select-none px-2 text-right text-[#666]">{index + 1}</span>
          <span className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words px-2">
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
