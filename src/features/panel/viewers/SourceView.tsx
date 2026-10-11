import { useEffect, useRef } from "react";

import { sourceLines } from "@/features/panel/diff/fold";
import { cn } from "@/lib/utils";

export function SourceView({ text, line }: { text: string; line: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const lines = sourceLines(text);
  useEffect(() => {
    scroller.current
      ?.querySelector(`[data-source-line="${line}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [line, text]);
  return (
    <div ref={scroller} className="h-full min-w-0 overflow-x-hidden overflow-y-auto font-mono text-xs leading-5">
      {lines.map((content, index) => {
        const number = index + 1;
        const hit = number === line;
        return (
          <div
            key={number}
            data-source-line={number}
            className={cn("flex min-w-0", hit && "bg-amber-400/20")}
          >
            <span className="w-10 shrink-0 select-none px-2 text-right text-zinc-500">{number}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words px-2 text-zinc-200">
              {content.length > 0 ? content : " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}
