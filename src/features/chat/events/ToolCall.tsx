import { useState } from "react";
import { ChevronRight, Image as ImageIcon, Play, Terminal, Wrench } from "lucide-react";

import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store";
import { relativizeDisplayText } from "@/features/panel/files/path";
import { CopyButton } from "./chrome";
import { EventImages } from "./EventImages";
import { toolGlyph, toolLineText } from "./tool-line";
import type { EventViewProps } from "./types";

const GLYPH = {
  command: Terminal,
  image: ImageIcon,
  tool: Wrench,
} as const;

/**
 * 工具、命令和 MCP 调用默认一行：图标、截断摘要、箭头。
 * 点开后才是完整命令和输出。文案来自适配器已规范化的 summary。
 */
export function ToolCall({ event, session }: EventViewProps) {
  const [open, setOpen] = useState(false);
  const projectPath = useWorkbench(
    (state) => state.projects.find((project) => project.id === session.project_id)?.path ?? "",
  );
  if (event.kind !== "tool-call") return null;
  const summary = relativizeDisplayText(event.summary, projectPath);
  const detail = relativizeDisplayText(event.detail ?? "", projectPath);
  const images = event.images ?? [];
  const line = relativizeDisplayText(toolLineText(event.name, event.summary), projectPath);
  const Icon = GLYPH[toolGlyph(event.name, images.length)];
  const copyText = [event.name, summary, detail].filter((part) => part.trim()).join("\n");
  const hasBody = summary.trim().length > 0 || detail.trim().length > 0 || images.length > 0;

  return (
    <div className="event-in group min-w-0 px-6 py-0.5 pl-12">
      <div className="min-w-0">
        <button
          type="button"
          data-tool-row
          data-tool-line={line}
          aria-expanded={hasBody ? open : undefined}
          onClick={() => {
            if (hasBody) setOpen((value) => !value);
          }}
          className="inline-flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#1a1a1a] px-2.5 py-1 text-left text-[12.5px] text-[#cfcfcf] hover:bg-[#222]"
        >
          {open ? <Icon className="h-3.5 w-3.5 shrink-0 text-[#888]" /> : <Play className="h-3 w-3 shrink-0 fill-current text-[#888]" />}
          <span className="min-w-0 truncate">{line}</span>
          {hasBody ? (
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-[#666] transition-transform duration-150",
                open && "rotate-90",
              )}
            />
          ) : null}
        </button>
        {open && hasBody ? (
          <div className="mt-1 min-w-0 overflow-x-hidden rounded-md border border-[#2a2a2a] bg-[#141414] px-2.5 py-1.5 font-mono text-xs">
            {summary.trim() ? (
              <p className="whitespace-pre-wrap break-all text-zinc-300">{summary}</p>
            ) : null}
            {detail.trim() ? (
              <p className="mt-1 overflow-x-hidden whitespace-pre-wrap break-all text-zinc-400">
                {detail}
              </p>
            ) : null}
            <EventImages
              paths={images}
              className="max-h-40 max-w-[160px] rounded-lg object-contain"
              frameClassName="mt-1 flex min-w-0 flex-wrap gap-1.5 overflow-x-hidden"
            />
            {copyText ? (
              <div className="mt-1 flex justify-end">
                <CopyButton text={copyText} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
