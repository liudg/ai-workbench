import { useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Circle,
  Copy,
  HelpCircle,
  MessageSquare,
  Info,
  Lock,
  Wrench,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatMessageTime } from "@/lib/utils";
import { fileName } from "../composer/media";
import { CODEX_DESKTOP } from "../codex-desktop";
import { AssistantAnswer } from "./AssistantAnswer";
import { annotationCountLabel } from "../changes/annotate";
import { ChatThumb } from "./ChatThumb";
import { MessageContent } from "./MessageContent";
import { useWorkbench } from "@/store";
import {
  AGENT_LABELS,
  type PromptQuestion,
  type Session,
  type SessionEvent,
} from "@/types";

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

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={copied ? "已复制" : "复制"}
      aria-label={copied ? "已复制" : "复制"}
      className={cn(
        "rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200",
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
function HoverActions({
  time,
  children,
}: {
  time: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mt-1 flex min-h-5 min-w-0 max-w-full items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <span className="px-0.5 text-[11px] tabular-nums text-zinc-500">{time}</span>
      {children}
    </div>
  );
}

function Row({
  icon,
  title,
  time,
  children,
  tone = "default",
  copyText,
  actionsBelow = false,
}: {
  icon: React.ReactNode;
  title: string;
  time: string;
  children: React.ReactNode;
  tone?: "default" | "muted";
  copyText?: string;
  actionsBelow?: boolean;
}) {
  return (
    <div className="event-in group min-w-0 px-6 py-2">
      <div className="mx-auto min-w-0 max-w-3xl">
        <div className="mb-1 flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-zinc-500">{icon}</span>
          <span
            className={cn(
              "min-w-0 break-words text-xs font-medium",
              tone === "muted" ? "text-zinc-500" : "text-zinc-400",
            )}
          >
            {title}
          </span>
          {actionsBelow ? null : (
            <>
              <span className="text-[11px] text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100">
                {time}
              </span>
              {copyText ? (
                <CopyButton
                  text={copyText}
                  className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                />
              ) : null}
            </>
          )}
        </div>
        <div className="min-w-0 cursor-text break-words pl-6">
          {children}
          {actionsBelow ? (
            <HoverActions time={time}>
              {copyText ? <CopyButton text={copyText} /> : null}
            </HoverActions>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function UserMessage({
  text,
  images,
  annotations = 0,
  time,
}: {
  text: string;
  images: string[];
  annotations?: number;
  time: string;
}) {
  const annotationOnly = annotations > 0 && !text.trim();
  return (
    <div className="event-in group min-w-0 px-6 py-2">
      <div className="mx-auto flex min-w-0 max-w-3xl justify-end">
        <div className="flex min-w-0 max-w-[85%] flex-col items-end gap-2">
          {annotationOnly ? (
            images.map((path) => (
              <ChatThumb
                key={path}
                path={path}
                name={fileName(path)}
                className="max-h-28 max-w-[140px] rounded-lg object-cover"
              />
            ))
          ) : (
            <div className="min-w-0 max-w-full cursor-text overflow-x-hidden rounded-2xl rounded-br-sm bg-indigo-600/90 px-4 py-2.5 text-sm leading-6 text-white">
              {images.length > 0 && (
                <div className="mb-1 flex min-w-0 flex-wrap gap-1.5 overflow-x-hidden">
                  {images.map((path) => (
                    <ChatThumb
                      key={path}
                      path={path}
                      name={fileName(path)}
                      className="max-h-40 max-w-[160px] rounded-lg object-contain"
                    />
                  ))}
                </div>
              )}
              {text ? <MessageContent text={text} /> : null}
            </div>
          )}
          {annotations > 0 ? (
            <span
              data-annotation-count={annotations}
              className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700"
            >
              <MessageSquare className="h-3 w-3" />
              {annotationCountLabel(annotations)}
            </span>
          ) : null}
          <HoverActions time={time}>
            {text ? <CopyButton text={text} /> : null}
          </HoverActions>
        </div>
      </div>
    </div>
  );
}

/** 问题卡片：适配器发出 prompt_kind=questions。一轮可多题；点选项只填入回答框，「发送」一次提交整卡。 */
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
    <div className="min-w-0 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="mb-2 flex min-w-0 items-center gap-2">
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
                <p className="break-words whitespace-pre-wrap text-sm leading-6 text-zinc-200">
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
                            "flex w-full min-w-0 items-baseline gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors",
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
                          <span className="min-w-0 break-words">
                            <span className="block break-words text-sm text-zinc-200">
                              {opt.label}
                            </span>
                            {opt.description && (
                              <span className="block break-words text-xs leading-5 text-zinc-500">
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
              className="break-words whitespace-pre-wrap text-sm leading-6 text-zinc-400"
            >
              {question.question}
            </p>
          ))}
          <p className="mt-1 break-words whitespace-pre-wrap text-xs text-zinc-500">
            {resolvedAnswer ? `已回答：\n${resolvedAnswer}` : "等待回答…"}
          </p>
        </>
      )}
    </div>
  );
}

function ElicitationCard({
  event,
  session,
  resolvedAnswer,
}: {
  event: Extract<SessionEvent, { kind: "prompt" }>;
  session: Session;
  resolvedAnswer: string | null;
}) {
  const answerPrompt = useWorkbench((s) => s.answerPrompt);
  const [values, setValues] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const interactive = resolvedAnswer === null && session.status === "needs-input";

  const submit = (action: "accept" | "decline" | "cancel") => {
    if (action !== "accept") {
      answerPrompt(session.id, event.prompt_id, { type: "elicitation", action });
      return;
    }
    const content: Record<string, string | number | boolean> = {};
    for (const question of event.questions) {
      if (question.input_kind === "boolean") {
        content[question.id] = Boolean(flags[question.id]);
        continue;
      }
      const raw = (values[question.id] ?? "").trim();
      if (!raw) {
        if (question.required) return;
        continue;
      }
      if (question.input_kind === "integer") {
        const parsed = Number.parseInt(raw, 10);
        content[question.id] = Number.isNaN(parsed) ? raw : parsed;
      } else if (question.input_kind === "number") {
        const parsed = Number(raw);
        content[question.id] = Number.isNaN(parsed) ? raw : parsed;
      } else {
        content[question.id] = raw;
      }
    }
    answerPrompt(session.id, event.prompt_id, {
      type: "elicitation",
      action: "accept",
      content,
    });
  };

  return (
    <div className="min-w-0 overflow-x-hidden rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <p className="min-w-0 break-words whitespace-pre-wrap text-sm leading-6 text-zinc-200">
        {event.question}
      </p>
      {interactive ? (
        <>
          <div className="mt-3 space-y-3">
            {event.questions.map((question) => (
              <label key={question.id} className="block min-w-0">
                <span className="mb-1 block break-words text-xs text-zinc-400">
                  {question.header || question.id}
                  {question.required ? " *" : ""}
                </span>
                {question.question && question.question !== question.header ? (
                  <span className="mb-1 block break-words text-[11px] text-zinc-500">
                    {question.question}
                  </span>
                ) : null}
                {question.input_kind === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={Boolean(flags[question.id])}
                    onChange={(change) =>
                      setFlags((current) => ({
                        ...current,
                        [question.id]: change.target.checked,
                      }))
                    }
                  />
                ) : question.options.length > 0 ? (
                  <select
                    aria-label={question.header || question.id}
                    value={values[question.id] ?? ""}
                    className="h-8 w-full min-w-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-200"
                    onChange={(change) =>
                      setValues((current) => ({
                        ...current,
                        [question.id]: change.target.value,
                      }))
                    }
                  >
                    <option value="" />
                    {question.options.map((option) => (
                      <option key={option.id} value={option.label}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={
                      question.is_secret
                        ? "password"
                        : question.input_kind === "number" || question.input_kind === "integer"
                          ? "number"
                          : "text"
                    }
                    value={values[question.id] ?? ""}
                    aria-label={question.header || question.id}
                    className="h-8 min-w-0"
                    onChange={(change) =>
                      setValues((current) => ({
                        ...current,
                        [question.id]: change.target.value,
                      }))
                    }
                  />
                )}
              </label>
            ))}
          </div>
          <div className="mt-3 flex min-w-0 flex-wrap gap-2">
            <Button type="button" size="sm" className="h-8" onClick={() => submit("accept")}>
              {CODEX_DESKTOP.elicitAccept}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => submit("decline")}
            >
              {CODEX_DESKTOP.elicitDecline}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => submit("cancel")}
            >
              {CODEX_DESKTOP.elicitCancel}
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-2 break-words text-xs text-zinc-500">
          {resolvedAnswer ? `已回答：${resolvedAnswer}` : "等待回答…"}
        </p>
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

  if (event.prompt_kind === "elicitation") {
    return (
      <ElicitationCard
        event={event}
        session={session}
        resolvedAnswer={resolvedAnswer}
      />
    );
  }

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
    <div className="min-w-0 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="mb-2 flex min-w-0 items-start gap-2">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <p className="min-w-0 break-words whitespace-pre-wrap text-sm leading-6 text-zinc-200">
          {event.question}
        </p>
      </div>
      {interactive ? (
        event.prompt_kind === "free-text" ? (
          <form
            className="flex min-w-0 gap-2 pl-6"
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
              className="h-8 min-w-0 flex-1"
              autoFocus
            />
            <Button type="submit" size="sm" className="h-8 shrink-0">
              回答
            </Button>
          </form>
        ) : (
          <div className="flex min-w-0 flex-wrap gap-2 pl-6">
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
            {event.question === CODEX_DESKTOP.implementPrompt && (
              <form
                className="flex min-w-0 basis-full gap-2"
                onSubmit={(submitEvent) => {
                  submitEvent.preventDefault();
                  if (!freeText.trim()) return;
                  answerPrompt(session.id, event.prompt_id, {
                    type: "single",
                    value: freeText.trim(),
                  });
                }}
              >
                <Input
                  value={freeText}
                  onChange={(change) => setFreeText(change.target.value)}
                  aria-label={CODEX_DESKTOP.other}
                  placeholder={CODEX_DESKTOP.other}
                  className="h-8 min-w-0 flex-1"
                />
                <Button type="submit" size="sm" variant="outline" className="h-8 shrink-0">
                  {CODEX_DESKTOP.other}
                </Button>
              </form>
            )}
          </div>
        )
      ) : (
        <p className="min-w-0 break-words pl-6 text-xs text-zinc-500">
          {resolvedLabel ? `已回答：${resolvedLabel}` : "等待回答…"}
        </p>
      )}
    </div>
  );
}

function ToolCallItem({
  name,
  summary,
  detail = "",
  images = [],
  time,
}: {
  name: string;
  summary: string;
  detail?: string;
  images?: string[];
  time: string;
}) {
  const [open, setOpen] = useState(false);
  const first = summary.split("\n")[0] || name;
  const copyText = [name, summary, detail].filter((part) => part.trim()).join("\n");
  return (
    <Row
      icon={<Wrench className="h-3.5 w-3.5" />}
      title="工具调用"
      time={time}
      tone="muted"
      copyText={copyText}
    >
      <div className="min-w-0 overflow-x-hidden rounded-md border border-zinc-800 bg-zinc-900/80 px-2.5 py-1.5 font-mono text-xs text-zinc-400">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full min-w-0 items-start gap-1 text-left"
        >
          <ChevronRight
            className={cn(
              "mt-0.5 h-3 w-3 shrink-0 text-zinc-600 transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0 break-all text-cyan-400">{name}</span>
        </button>
        {open ? (
          <div className="mt-1 min-w-0 overflow-x-hidden pl-4">
            {summary ? (
              <p className="whitespace-pre-wrap break-all text-zinc-500">{summary}</p>
            ) : null}
            {detail ? (
              <p className="mt-1 overflow-x-hidden whitespace-pre-wrap break-all text-zinc-400">
                {detail}
              </p>
            ) : null}
            {images.length > 0 && (
              <div className="mt-1 flex min-w-0 flex-wrap gap-1.5 overflow-x-hidden">
                {images.map((path) => (
                  <ChatThumb
                    key={path}
                    path={path}
                    name={fileName(path)}
                    className="max-h-40 max-w-[160px] rounded-lg object-contain"
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="mt-1 overflow-x-hidden break-all pl-4 text-zinc-500">{first}</p>
        )}
      </div>
    </Row>
  );
}

function ThinkingBlock({
  text,
  time,
  expanded,
  onToggle,
}: {
  text: string;
  time: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="event-in group min-w-0 px-6 py-2">
      <div className="mx-auto min-w-0 max-w-3xl">
        <div className="mb-1 flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggle}
            className="flex items-center gap-2 text-left"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform",
                expanded && "rotate-90",
              )}
            />
            <Brain className="h-3.5 w-3.5 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-500">思考</span>
          </button>
          <span className="text-[11px] text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100">
            {time}
          </span>
          <CopyButton
            text={text}
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          />
        </div>
        {expanded ? (
          <p className="min-w-0 break-words whitespace-pre-wrap pl-6 text-sm leading-6 text-zinc-400">
            {text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PlanStepsBlock({
  explanation,
  steps,
}: {
  explanation: string;
  steps: { step: string; status: string }[];
}) {
  return (
    <div className="event-in min-w-0 px-6 py-2">
      <div className="mx-auto min-w-0 max-w-3xl rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
        <p className="text-xs font-medium text-zinc-300">{CODEX_DESKTOP.planTitle}</p>
        {explanation ? (
          <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-6 text-zinc-400">
            {explanation}
          </p>
        ) : null}
        <ol className="mt-2 space-y-1.5">
          {steps.map((step, index) => (
            <li key={`${index}-${step.step}`} className="flex min-w-0 items-start gap-2 text-sm text-zinc-200">
              <PlanMark status={step.status} />
              <span className="min-w-0 break-words whitespace-pre-wrap">{step.step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function PlanMark({ status }: { status: string }) {
  if (status === "completed") {
    return <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-emerald-400" />;
  }
  if (status === "inProgress") {
    return <Circle className="mt-1 h-3.5 w-3.5 shrink-0 fill-zinc-200 text-zinc-200" />;
  }
  return <Circle className="mt-1 h-3.5 w-3.5 shrink-0 text-zinc-600" />;
}

function ReviewFindingsBlock({
  summary,
  findings,
}: {
  summary: string;
  findings: { title: string; location: string; body: string }[];
}) {
  return (
    <div className="event-in min-w-0 px-6 py-2">
      <div className="mx-auto min-w-0 max-w-3xl rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
        <p className="text-xs font-medium text-zinc-300">{CODEX_DESKTOP.reviewTitle}</p>
        {summary ? (
          <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-6 text-zinc-200">
            {summary}
          </p>
        ) : null}
        <div className="mt-2 space-y-3">
          {findings.map((finding, index) => (
            <div key={`${finding.location}-${index}`} className="min-w-0">
              <p className="break-words text-sm text-zinc-100">{finding.title}</p>
              {finding.location ? (
                <p className="break-all font-mono text-xs text-zinc-500">{finding.location}</p>
              ) : null}
              {finding.body ? (
                <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-6 text-zinc-400">
                  {finding.body}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function EventItem({
  event,
  session,
  resolvedAnswer,
  thinkingOpen = false,
  onToggleThinking,
  showAgentLabel = true,
}: {
  event: SessionEvent;
  session: Session;
  resolvedAnswer: string | null;
  thinkingOpen?: boolean;
  onToggleThinking?: () => void;
  /** 一轮只在最终答复上标一次 Agent，旁白不再重复。 */
  showAgentLabel?: boolean;
}) {
  const time = formatMessageTime(event.ts);

  switch (event.kind) {
    case "user-message":
      return (
        <UserMessage
          text={event.text}
          images={event.images ?? []}
          annotations={event.annotations}
          time={time}
        />
      );

    case "turn-anchor":
    case "collaboration-mode":
      return null;

    case "turn-diff":
      return null;

    case "plan-steps":
      return <PlanStepsBlock explanation={event.explanation ?? ""} steps={event.steps} />;

    case "plan-text":
      return (
        <div className="event-in min-w-0 px-6 py-1">
          <div className="mx-auto min-w-0 max-w-3xl pl-6">
            <AssistantAnswer text={event.text} />
          </div>
        </div>
      );

    case "review-note":
      return (
        <div className="event-in min-w-0 px-6 py-1.5">
          <p className="mx-auto min-w-0 max-w-3xl break-words whitespace-pre-wrap pl-6 text-xs leading-5 text-zinc-500">
            {event.text}
          </p>
        </div>
      );

    case "review-findings":
      return <ReviewFindingsBlock summary={event.summary} findings={event.findings} />;

    case "agent-message":
      if (!showAgentLabel) {
        return (
          <div className="event-in min-w-0 px-6 py-1">
            <div className="mx-auto min-w-0 max-w-3xl pl-6">
              <AssistantAnswer text={event.text} />
            </div>
          </div>
        );
      }
      return (
        <Row
          icon={<Bot className="h-3.5 w-3.5" />}
          title={AGENT_LABELS[session.agent]}
          time={time}
          copyText={event.text}
          actionsBelow
        >
          <AssistantAnswer text={event.text} />
        </Row>
      );

    case "thinking":
      return (
        <ThinkingBlock
          text={event.text}
          time={time}
          expanded={thinkingOpen}
          onToggle={onToggleThinking ?? (() => undefined)}
        />
      );

    case "tool-call":
      return (
        <ToolCallItem
          name={event.name}
          summary={event.summary}
          detail={event.detail}
          images={event.images}
          time={time}
        />
      );

    case "prompt":
      return (
        <div className="event-in min-w-0 px-6 py-2">
          <div className="mx-auto min-w-0 max-w-3xl pl-6">
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
      return null; // 状态变化不进时间线

    case "system":
      return (
        <div className="event-in min-w-0 px-6 py-1.5">
          <div className="mx-auto flex min-w-0 max-w-3xl gap-1.5 text-xs leading-5 text-zinc-500">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <p className="min-w-0 break-words whitespace-pre-wrap">{event.text}</p>
          </div>
        </div>
      );

    case "read-only":
      return (
        <div className="event-in min-w-0 px-6 py-2">
          <div className="mx-auto flex min-w-0 max-w-3xl items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm leading-6 text-amber-100">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 break-words">{event.text}</p>
          </div>
        </div>
      );

    case "error":
      return (
        <div className="event-in min-w-0 px-6 py-2">
          <div className="mx-auto flex min-w-0 max-w-3xl items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-sm text-red-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 break-words">{event.message}</p>
          </div>
        </div>
      );
  }
}
