import { useState } from "react";
import {
  AlertCircle,
  Bot,
  ChevronRight,
  HelpCircle,
  Info,
  Wrench,
} from "lucide-react";

import { cn, formatTime } from "@/lib/utils";
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
    <div className="event-in px-6 py-2">
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
        </div>
        <div className="pl-6">{children}</div>
      </div>
    </div>
  );
}

/** 工具调用默认折叠成一行（Codex 风格），点开看完整输入输出。 */
function ToolCallItem({
  event,
  time,
}: {
  event: Extract<SessionEvent, { kind: "tool-call" }>;
  time: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const firstLine = event.summary.split("\n", 1)[0] ?? "";

  return (
    <div className="event-in px-6 py-1">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="group flex min-w-0 flex-1 items-center gap-2 rounded py-0.5 text-left"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform duration-150",
                expanded && "rotate-90",
              )}
            />
            <Wrench className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
            <span className="shrink-0 font-mono text-xs text-cyan-400/90">
              {event.name}
            </span>
            {firstLine ? (
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-500 group-hover:text-zinc-400">
                {firstLine}
              </span>
            ) : null}
          </button>
          <span className="shrink-0 text-[11px] text-zinc-600">{time}</span>
        </div>
        {expanded && event.summary ? (
          <div className="ml-6 mt-1 rounded-md border border-zinc-800 bg-zinc-900/80 px-2.5 py-1.5 font-mono text-xs leading-5 text-zinc-400">
            <p className="whitespace-pre-wrap break-all">{event.summary}</p>
          </div>
        ) : null}
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
        <p className="text-sm leading-6 text-zinc-200">{event.question}</p>
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
            <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600/90 px-4 py-2.5 text-sm leading-6 text-white">
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
        >
          <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-300">
            {event.text}
          </p>
        </Row>
      );

    case "tool-call":
      return <ToolCallItem event={event} time={time} />;

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
        <div className="event-in flex items-center justify-center gap-1.5 px-6 py-1.5 text-xs text-zinc-600">
          <Info className="h-3 w-3" />
          {event.text}
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
