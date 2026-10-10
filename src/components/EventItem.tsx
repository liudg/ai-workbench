import { useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  Copy,
  HelpCircle,
  Info,
  Pencil,
  Wrench,
} from "lucide-react";

import { cn, formatMessageTime } from "@/lib/utils";
import { useWorkbench } from "@/store";
import { AGENT_LABELS, type Session, type SessionEvent } from "@/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function Row({
  icon,
  title,
  time,
  children,
  tone = "default",
}: {
  icon: React.ReactNode;
  title: string;
  time: string;
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
          <span className="text-[11px] text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100">
            {time}
          </span>
        </div>
        <div className="pl-6">{children}</div>
      </div>
    </div>
  );
}

function UserMessage({
  sessionId,
  text,
  time,
}: {
  sessionId: string;
  text: string;
  time: string;
}) {
  const seedComposer = useWorkbench((s) => s.seedComposer);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
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
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="event-in group px-6 py-2">
      <div className="mx-auto flex max-w-3xl justify-end">
        <div className="flex max-w-[85%] flex-col items-end">
          <div className="rounded-2xl rounded-br-sm bg-indigo-600/90 px-4 py-2.5 text-sm leading-6 text-white">
            <p className="whitespace-pre-wrap">{text}</p>
          </div>
          <div className="flex max-h-0 items-center gap-1 overflow-hidden opacity-0 group-hover:mt-1 group-hover:max-h-6 group-hover:overflow-visible group-hover:opacity-100 group-focus-within:mt-1 group-focus-within:max-h-6 group-focus-within:overflow-visible group-focus-within:opacity-100">
            <span className="px-0.5 text-[11px] tabular-nums text-zinc-500">{time}</span>
            <button
              type="button"
              title={copied ? "已复制" : "复制"}
              aria-label={copied ? "已复制" : "复制"}
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              onClick={() => void copy()}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              title="编辑"
              aria-label="编辑"
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              onClick={() => seedComposer(sessionId, text)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
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
  const time = formatMessageTime(event.ts);

  switch (event.kind) {
    case "user-message":
      return <UserMessage sessionId={session.id} text={event.text} time={time} />;

    case "agent-message":
      return (
        <Row
          icon={<Bot className="h-3.5 w-3.5" />}
          title={AGENT_LABELS[session.agent]}
          time={time}
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
      return null; // 状态只在会话标签上呈现

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
