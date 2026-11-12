import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={copied ? "已复制" : "复制"}
      aria-label={copied ? "已复制" : "复制"}
      className={cn(
        "rounded-md p-0.5 text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg",
        className,
      )}
      onClick={() => {
        void writeClipboard(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/** 时间与操作始终占位，悬停只改透明度，避免把后面的消息顶下去。 */
export function HoverActions({ time, children }: { time: string; children?: ReactNode }) {
  return (
    <div className="mt-1 flex min-h-5 min-w-0 max-w-full items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <span className="px-0.5 text-[11px] tabular-nums text-wb-fg-3">{time}</span>
      {children}
    </div>
  );
}

export function MessageFooter({ time, copyText }: { time: string; copyText?: string }) {
  return (
    <div data-message-footer>
      <HoverActions time={time}>{copyText ? <CopyButton text={copyText} /> : null}</HoverActions>
    </div>
  );
}

export function Row({
  icon,
  title,
  time,
  children,
  tone = "default",
  copyText,
  chrome = "inline",
}: {
  icon: ReactNode;
  title: string;
  time: string;
  children: ReactNode;
  tone?: "default" | "muted";
  copyText?: string;
  /** 时间与复制。`below` 跟在正文下面；折叠行已经带了名字时用 `hidden`。 */
  chrome?: "inline" | "below" | "hidden";
}) {
  return (
    <div className="event-in group min-w-0 px-6 py-2">
      <div className="min-w-0">
        <div className="mb-1 flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-wb-fg-3">{icon}</span>
          <span
            data-agent-label={title}
            className={cn(
              "min-w-0 break-words text-xs font-medium",
              tone === "muted" ? "text-wb-fg-3" : "text-wb-fg-2",
            )}
          >
            {title}
          </span>
          {chrome === "inline" ? (
            <>
              <span className="text-[11px] tabular-nums text-wb-fg-3 opacity-0 transition-opacity group-hover:opacity-100">
                {time}
              </span>
              {copyText ? (
                <CopyButton
                  text={copyText}
                  className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                />
              ) : null}
            </>
          ) : null}
        </div>
        <div className="min-w-0 cursor-text break-words pl-6">
          {children}
          {chrome === "below" ? (
            <MessageFooter time={time} copyText={copyText} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
