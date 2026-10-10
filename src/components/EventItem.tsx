import { useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  Copy,
  HelpCircle,
  Info,
  Wrench,
} from "lucide-react";

import { cn, formatTime } from "@/lib/utils";
import { useWorkbench } from "@/store";
import { AGENT_LABELS, type Session, type SessionEvent } from "@/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={copied ? "已复制" : "复制"}
      aria-label={copied ? "已复制" : "复制"}
      className="rounded p-0.5 text-zinc-500 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100 group-focus-within:opacity-100"
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

function Row({
  icon,
  title,
  time,
  copyText,
  children,
  tone = "default",
}: {
  icon: React.ReactNode;
  title: string;
  time: string;
  copyText?: string;
  children: React.ReactNode;
  tone?: "default" | "muted";
}) {
  return (
    <div className="event-in group px-6 py-2">
      <div className="mx-auto max-w-3xl">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-zinc-500">{icon}</span>
          <span
            className={cn(
              "text-xs font-medium",
              tone === "muted" ? "text-zinc-500" : "text-zinc-400",
            )}
          >
            {title}
          </span>
          <span className="text-[11px] text-zinc-600">{time}</span>
          {copyText ? <CopyButton text={copyText} /> : null}
        </div>
        <div className="cursor-text pl-6">{children}</div>
      </div>
    </div>
  );
}

function PromptCard({
  event,
  session,
  resolvedAnswer,
}: {
  event: Extract<SessionEvent, { kind: "prompt" }>;
  session: Session;
  resolvedAnswer: string | null;
}) {
  const answerPrompt = useWorkbench((s) => s.answerPrompt);
  const [freeText, setFreeText] = useState("");
  const interactive = resolvedAnswer === null && session.status === "needs-input";

  const resolvedLabel = resolvedAnswer
    ? (event.options.find((o) => o.id === resolvedAnswer)?.label ??
      resolvedAnswer)
    : null;

  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="mb-2 flex items-start gap-2">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-200">
          {event.question}
        </p>
      </div>
      {interactive ? (
        event.prompt_kind === "free-text" ? (
          <form
            className="flex gap-2 pl-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (freeText.trim()) {
                answerPrompt(session.id, event.prompt_id, freeText.trim());
              }
            }}
          >
            <Input
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder="输入你的回答…"
              className="h-8"
              autoFocus
            />
            <Button type="submit" size="sm" className="h-8">
              回答
            </Button>
          </form>
        ) : (
          <div className="flex gap-2 pl-6">
            {event.options.map((opt) => (
              <Button
                key={opt.id}
                size="sm"
                variant={opt.id === "reject" ? "outline" : "default"}
                onClick={() => answerPrompt(session.id, event.prompt_id, opt.id)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        )
      ) : (
        <p className="pl-6 text-xs text-zinc-500">
          {resolvedLabel ? `已回答：${resolvedLabel}` : "等待回答…"}
        </p>
      )}
    </div>
  );
}

export function EventItem({
  event,
  session,
  resolvedAnswer,
}: {
  event: SessionEvent;
  session: Session;
  resolvedAnswer: string | null;
}) {
  const time = formatTime(event.ts);

  switch (event.kind) {
    case "user-message":
      return (
        <div className="event-in px-6 py-2">
          <div className="mx-auto flex max-w-3xl justify-end">
            <div className="max-w-[85%] cursor-text rounded-2xl rounded-br-sm bg-indigo-600/90 px-4 py-2.5 text-sm leading-6 text-white">
              <p className="whitespace-pre-wrap">{event.text}</p>
              <p className="mt-1 text-right text-[10px] text-indigo-200/70">
                {time}
              </p>
            </div>
          </div>
        </div>
      );

    case "agent-message":
      return (
        <Row
          icon={<Bot className="h-3.5 w-3.5" />}
          title={AGENT_LABELS[session.agent]}
          time={time}
          copyText={event.text}
        >
          <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-300">
            {event.text}
          </p>
        </Row>
      );

    case "tool-call":
      return (
        <Row
          icon={<Wrench className="h-3.5 w-3.5" />}
          title="工具调用"
          time={time}
          tone="muted"
          copyText={`${event.name}\n${event.summary}`}
        >
          <div className="rounded-md border border-zinc-800 bg-zinc-900/80 px-2.5 py-1.5 font-mono text-xs text-zinc-400">
            <span className="text-cyan-400">{event.name}</span>
            <p className="mt-1 whitespace-pre-wrap break-all text-zinc-500">
              {event.summary}
            </p>
          </div>
        </Row>
      );

    case "prompt":
      return (
        <div className="event-in px-6 py-2">
          <div className="mx-auto max-w-3xl pl-6">
            <PromptCard
              event={event}
              session={session}
              resolvedAnswer={resolvedAnswer}
            />
          </div>
        </div>
      );

    case "prompt-resolved":
      return null; // 已在 PromptCard 的「已回答」状态体现

    case "status-changed":
      return null; // 状态由标签页 / 顶栏呈现，时间线不冗余展示

    case "system":
      return (
        <div className="event-in px-6 py-1.5">
          <div className="mx-auto flex max-w-3xl gap-1.5 text-xs leading-5 text-zinc-500">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <p className="min-w-0 whitespace-pre-wrap">{event.text}</p>
          </div>
        </div>
      );

    case "error":
      return (
        <div className="event-in px-6 py-2">
          <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-sm text-red-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {event.message}
          </div>
        </div>
      );
  }
}
