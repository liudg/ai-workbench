import { useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  HelpCircle,
  Info,
  Wrench,
  X,
} from "lucide-react";

import { cn, formatTime } from "@/lib/utils";
import { useWorkbench } from "@/store";
import {
  AGENT_LABELS,
  type PromptQuestion,
  type Session,
  type SessionEvent,
} from "@/types";
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

/** Codex 原生问题卡片：一轮可多题；点选项只填入回答框，「发送」一次提交整卡（对齐 Codex TUI）。 */
function QuestionCard({
  event,
  session,
  resolvedAnswer,
}: {
  event: Extract<SessionEvent, { kind: "prompt" }>;
  session: Session;
  resolvedAnswer: string | null;
}) {
  const answerPrompt = useWorkbench((s) => s.answerPrompt);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const interactive = resolvedAnswer === null && session.status === "needs-input";

  const skip = () =>
    answerPrompt(session.id, event.prompt_id, {
      type: "questions",
      answers: {},
      skipped: true,
    });

  const submit = () => {
    const filled = Object.fromEntries(
      Object.entries(answers)
        .map(([id, text]) => [id, text.trim()] as const)
        .filter(([, text]) => text.length > 0),
    );
    if (Object.keys(filled).length === 0) return;
    answerPrompt(session.id, event.prompt_id, {
      type: "questions",
      answers: filled,
      skipped: false,
    });
  };

  const fillOption = (question: PromptQuestion, label: string) => {
    setAnswers((current) => ({ ...current, [question.id]: label }));
    inputRefs.current[question.id]?.focus();
  };

  const canSend = Object.values(answers).some((text) => text.trim().length > 0);

  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="mb-2 flex items-center gap-2">
        <HelpCircle className="h-4 w-4 shrink-0 text-amber-400" />
        <span className="text-xs font-medium text-zinc-400">问题</span>
        {interactive && (
          <button
            type="button"
            title="跳过"
            aria-label="跳过"
            className="ml-auto rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            onClick={skip}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {interactive ? (
        <>
          <div className="space-y-4">
            {event.questions.map((question, qIndex) => (
              <div
                key={question.id}
                className={cn(qIndex > 0 && "border-t border-amber-500/15 pt-3")}
              >
                {question.header && (
                  <p className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                    {question.header}
                  </p>
                )}
                <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-200">
                  {question.question}
                </p>
                {question.options.length > 0 && (
                  <div className="mt-1.5 space-y-1">
                    {question.options.map((opt, index) => {
                      const selected = answers[question.id] === opt.label;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          title={opt.description || undefined}
                          className={cn(
                            "flex w-full items-baseline gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                            selected
                              ? "border-indigo-500/60 bg-indigo-500/15"
                              : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-800/70",
                          )}
                          onClick={() => fillOption(question, opt.label)}
                        >
                          <span
                            className={cn(
                              "shrink-0 font-mono text-xs tabular-nums",
                              selected ? "text-indigo-300" : "text-zinc-500",
                            )}
                          >
                            {index + 1}.
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm text-zinc-200">
                              {opt.label}
                            </span>
                            {opt.description && (
                              <span className="block text-xs leading-5 text-zinc-500">
                                {opt.description}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <Input
                  ref={(el) => {
                    inputRefs.current[question.id] = el;
                  }}
                  value={answers[question.id] ?? ""}
                  onChange={(e) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: e.target.value,
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  type={question.is_secret ? "password" : "text"}
                  placeholder="或自行撰写回复"
                  className="mt-1.5 h-8"
                  autoFocus={qIndex === 0}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={skip}>
              跳过
            </Button>
            <Button size="sm" onClick={submit} disabled={!canSend}>
              发送
            </Button>
          </div>
        </>
      ) : (
        <>
          {event.questions.map((question) => (
            <p
              key={question.id}
              className="whitespace-pre-wrap text-sm leading-6 text-zinc-400"
            >
              {question.question}
            </p>
          ))}
          <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-500">
            {resolvedAnswer ? `已回答：\n${resolvedAnswer}` : "等待回答…"}
          </p>
        </>
      )}
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

  if (event.prompt_kind === "questions") {
    return (
      <QuestionCard
        event={event}
        session={session}
        resolvedAnswer={resolvedAnswer}
      />
    );
  }

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
                answerPrompt(session.id, event.prompt_id, {
                  type: "single",
                  value: freeText.trim(),
                });
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
                onClick={() =>
                  answerPrompt(session.id, event.prompt_id, {
                    type: "single",
                    value: opt.id,
                  })
                }
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
