import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { CopyButton } from "./chrome";
import { EventImages } from "./EventImages";
import { commandIsLong, outputPreview } from "./tool-output";
import { useFollowBottom } from "./useFollowBottom";

/**
 * 一步工具调用点开后的内容：命令在上，输出在下。
 * 长命令先收成三行；输出框限高滚动，长输出只留结尾，可以再要全文。
 * 还在跑时输出框跟着底部走。
 * 照 t3code `TimelineWorkEntryRow.tsx`（`max-h-64 overflow-auto`、`WorkLogDetails followLive`）
 * 和 orca `NativeChatToolOutput.tsx`（截断后「Show full output」）。
 */
export function ToolOutput({
  command,
  output,
  images,
  copyText,
  running,
}: {
  /** 命令或调用摘要。和步骤标题一样时由调用方传空。 */
  command: string;
  output: string;
  images: string[];
  copyText: string;
  running: boolean;
}) {
  const [commandOpen, setCommandOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const longCommand = commandIsLong(command);
  const preview = useMemo(() => outputPreview(output), [output]);
  const shown = showAll ? output : preview.text;
  // 只留了结尾的输出也从底部看起；点「显示全部」后前面的行补在上方，视野不跳。
  const follow = useFollowBottom<HTMLPreElement>(running || preview.hiddenLines > 0, shown);

  return (
    <div data-tool-output className="min-w-0 space-y-1.5 font-mono text-xs">
      {command ? (
        <div className="min-w-0">
          <p
            data-tool-command
            className={cn(
              "whitespace-pre-wrap break-all text-wb-fg",
              longCommand && !commandOpen && "line-clamp-3",
            )}
          >
            {command}
          </p>
          {longCommand ? (
            <button
              type="button"
              onClick={() => setCommandOpen((value) => !value)}
              className="mt-0.5 font-sans text-[11.5px] text-wb-fg-3 hover:text-wb-fg"
            >
              {commandOpen ? DESKTOP_ZH.toolCommandLess : DESKTOP_ZH.toolCommandMore}
            </button>
          ) : null}
        </div>
      ) : null}
      {output ? (
        <div className="min-w-0 overflow-hidden rounded-lg border border-wb-border bg-wb-code">
          {preview.hiddenLines > 0 && !showAll ? (
            <div className="flex items-center gap-2 border-b border-wb-border px-2.5 py-1 font-sans text-[11.5px] text-wb-fg-3">
              <span>{DESKTOP_ZH.toolOutputHidden.replace("{count}", String(preview.hiddenLines))}</span>
              <button
                type="button"
                data-tool-output-all
                onClick={() => setShowAll(true)}
                className="text-wb-fg-2 hover:text-wb-fg"
              >
                {DESKTOP_ZH.toolOutputShowAll}
              </button>
            </div>
          ) : null}
          <pre
            ref={follow.ref}
            onScroll={follow.onScroll}
            data-own-scroll
            className="max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap break-all px-2.5 py-1.5 font-mono text-wb-fg-2"
          >
            {shown}
          </pre>
        </div>
      ) : null}
      <EventImages
        paths={images}
        className="max-h-40 max-w-[160px] rounded-lg object-contain"
        frameClassName="flex min-w-0 flex-wrap gap-1.5 overflow-x-hidden"
      />
      {copyText ? (
        <div className="flex justify-end">
          <CopyButton text={copyText} />
        </div>
      ) : null}
    </div>
  );
}
