import { useEffect, useRef } from "react";

import { sourceLines } from "../core/source-lines";
import { cn } from "@/lib/utils";
import { highlightLine } from "./highlight";

export function SourceView({ text, line }: { text: string; line: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const lines = sourceLines(text);
  useEffect(() => {
    scroller.current
      ?.querySelector(`[data-source-line="${line}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [line, text]);
  return (
    <div ref={scroller} className="h-full min-w-0 overflow-x-hidden overflow-y-auto bg-[#0f0f0f] font-mono text-[12.5px] leading-5">
      {lines.map((content, index) => {
        const number = index + 1;
        const hit = number === line;
        return (
          <div
            key={number}
            data-source-line={number}
            className={cn("flex min-w-0", hit && "bg-[#1e2a3a]")}
          >
            <span className="w-10 shrink-0 select-none px-2 text-right text-[#666]">{number}</span>
            <span className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words px-2">
              <HighlightedText text={content} />
            </span>
          </div>
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
