import { useState } from "react";
import { ChevronRight, Wrench } from "lucide-react";

import { cn } from "@/lib/utils";
import { Row } from "./chrome";
import { EventImages } from "./EventImages";
import type { EventViewProps } from "./types";

export function ToolCall({ event, time }: EventViewProps) {
  const [open, setOpen] = useState(false);
  if (event.kind !== "tool-call") return null;
  const name = event.name;
  const summary = event.summary;
  const detail = event.detail ?? "";
  const images = event.images ?? [];
  const first = summary.split("\n")[0] || name;
  const copyText = [name, summary, detail].filter((part) => part.trim()).join("\n");
  return (
    <Row icon={<Wrench className="h-3.5 w-3.5" />} title="工具调用" time={time} tone="muted" copyText={copyText}>
      <div className="min-w-0 overflow-x-hidden rounded-md border border-zinc-800 bg-zinc-900/80 px-2.5 py-1.5 font-mono text-xs text-zinc-400">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full min-w-0 items-start gap-1 text-left"
        >
          <ChevronRight
            className={cn("mt-0.5 h-3 w-3 shrink-0 text-zinc-600 transition-transform", open && "rotate-90")}
          />
          <span className="min-w-0 break-all text-cyan-400">{name}</span>
        </button>
        {open ? (
          <div className="mt-1 min-w-0 overflow-x-hidden pl-4">
            {summary ? <p className="whitespace-pre-wrap break-all text-zinc-500">{summary}</p> : null}
            {detail ? (
              <p className="mt-1 overflow-x-hidden whitespace-pre-wrap break-all text-zinc-400">{detail}</p>
            ) : null}
            <EventImages
              paths={images}
              className="max-h-40 max-w-[160px] rounded-lg object-contain"
              frameClassName="mt-1 flex min-w-0 flex-wrap gap-1.5 overflow-x-hidden"
            />
          </div>
        ) : (
          <p className="mt-1 overflow-x-hidden break-all pl-4 text-zinc-500">{first}</p>
        )}
      </div>
    </Row>
  );
}
