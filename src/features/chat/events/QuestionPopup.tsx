import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HelpCircle, Pencil, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PromptQuestion, SessionEvent } from "@/types";
import { placeQuestionPopup, type QuestionPopupPlace } from "./question-popup-place";
import {
  createQuestionStep,
  dismissQuestionStep,
  questionStepCursor,
  sendQuestionStep,
  skipQuestionStep,
  type QuestionStepEffect,
  type QuestionStepState,
} from "./question-steps";
import { useAnswerPrompt } from "./useAnswerPrompt";

/**
 * 提问浮在作曲栏上方，所有 Agent 共用。
 * 时间线只留摘要；回答仍走原来的 answerPrompt。
 */
export function QuestionPopup({
  event,
  sessionId,
  anchor,
}: {
  event: Extract<SessionEvent, { kind: "prompt" }>;
  sessionId: string;
  anchor: HTMLElement | null;
}) {
  const answerPrompt = useAnswerPrompt();
  const place = useQuestionPopupPlace(anchor);
  const [step, setStep] = useState<QuestionStepState>(createQuestionStep);
  const [closed, setClosed] = useState(false);
  const lock = useRef(false);
  const questions = event.questions;
  const cursor = questionStepCursor(step, questions.length);
  const question = questions[cursor.index];

  const submitAnswers = (answers: Record<string, string>, skipped: boolean) => {
    if (lock.current) return;
    lock.current = true;
    setClosed(true);
    void Promise.resolve(
      answerPrompt(sessionId, event.prompt_id, {
        type: "questions",
        answers,
        skipped,
      }),
    )
      .then((result) => {
        if (result === false) {
          lock.current = false;
          setClosed(false);
        }
      })
      .catch(() => {
        lock.current = false;
        setClosed(false);
      });
  };

  const apply = (effect: QuestionStepEffect) => {
    if (effect.type === "advance") {
      setStep(effect.state);
      return;
    }
    if (effect.type === "submit") submitAnswers(effect.answers, effect.skipped);
  };

  if (!question || !place || closed || typeof document === "undefined") return null;

  const canSend = step.draft.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    apply(sendQuestionStep(step, questions));
  };

  return createPortal(
    <div
      data-question-popup
      role="dialog"
      aria-label="问题"
      className="fixed z-40"
      style={{
        left: place.left,
        width: place.width,
        bottom: place.bottom,
        maxHeight: place.maxHeight,
      }}
    >
      <div
        style={{ maxHeight: place.maxHeight }}
        className="select-text overflow-y-auto rounded-[18px] border border-[#2a2a2a] bg-[#171717] text-[#e8e8e8] shadow-[0_16px_48px_rgba(0,0,0,0.45)] [&_button]:select-none"
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === "Escape" && !keyEvent.nativeEvent.isComposing) {
            keyEvent.preventDefault();
            apply(dismissQuestionStep());
          }
        }}
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 bg-[#171717] px-4 pb-1 pt-3.5">
          <HelpCircle className="h-4 w-4 shrink-0 text-zinc-400" />
          <span className="text-sm text-zinc-300">问题</span>
          <span className="ml-auto flex items-center gap-1.5">
            {questions.length > 1 ? (
              <span className="px-1 text-xs tabular-nums text-zinc-500">
                {cursor.index + 1}/{questions.length}
              </span>
            ) : null}
            <button
              type="button"
              aria-label="关闭"
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-zinc-500 hover:bg-[#2a2a2a] hover:text-zinc-200"
              onClick={() => apply(dismissQuestionStep())}
            >
              <X className="h-4 w-4" />
            </button>
          </span>
        </div>
        <div className="px-4 pb-2 pt-2">
          {question.header?.trim() && question.header.trim() !== question.question.trim() ? (
            <p className="mb-1 break-words text-xs text-zinc-500">{question.header}</p>
          ) : null}
          <p className="break-words whitespace-pre-wrap text-[15px] leading-6 text-[#f3f3f3]">
            {question.question}
          </p>
          {question.options.length > 0 ? (
            <div className="mt-3 space-y-1.5" role="listbox" aria-label={question.question}>
              {question.options.map((opt, index) => (
                <OptionRow
                  key={opt.id}
                  index={index}
                  option={opt}
                  selected={step.draft === opt.label}
                  onPick={() => setStep((current) => ({ ...current, draft: opt.label }))}
                />
              ))}
            </div>
          ) : null}
        </div>
        <div className="sticky bottom-0 flex items-center gap-2 border-t border-[#2a2a2a] bg-[#171717] px-3 py-2.5">
          <Pencil className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            key={question.id}
            value={step.draft}
            onChange={(change) => {
              const draft = change.target.value;
              setStep((current) => ({ ...current, draft }));
            }}
            onKeyDown={(keyEvent) => {
              if (keyEvent.key === "Enter" && !keyEvent.nativeEvent.isComposing) {
                keyEvent.preventDefault();
                send();
              }
            }}
            type={question.is_secret ? "password" : "text"}
            placeholder="或自行撰写回复"
            autoFocus
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-sm text-[#f3f3f3] outline-none placeholder:text-zinc-500"
          />
          <button
            type="button"
            data-question-skip
            className="h-8 shrink-0 cursor-pointer rounded-full bg-[#2a2a2a] px-3 text-sm text-[#e8e8e8] hover:bg-[#333]"
            onClick={() => apply(skipQuestionStep(step, questions))}
          >
            跳过
          </button>
          <button
            type="button"
            data-question-send
            disabled={!canSend}
            className="h-8 shrink-0 cursor-pointer rounded-full bg-[#f2f2f2] px-3.5 text-sm font-medium text-[#171717] hover:bg-white disabled:cursor-not-allowed disabled:bg-[#2a2a2a] disabled:text-[#666]"
            onClick={send}
          >
            发送
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function OptionRow({
  index,
  option,
  selected,
  onPick,
}: {
  index: number;
  option: PromptQuestion["options"][number];
  selected: boolean;
  onPick: () => void;
}) {
  const disabled = Boolean(option.disabled_reason);
  const note = option.disabled_reason || option.description;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={disabled}
      disabled={disabled}
      data-question-option={index + 1}
      className={cn(
        "flex w-full min-w-0 items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors",
        disabled
          ? "cursor-not-allowed border-[#2a2a2a] opacity-50"
          : selected
            ? "cursor-pointer border-[#6e5bff]/70 bg-[#6e5bff]/12"
            : "cursor-pointer border-[#2c2c2c] bg-[#141414] hover:border-[#3a3a3a] hover:bg-[#1c1c1c]",
      )}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPick}
    >
      <span
        className={cn(
          "mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md border px-1 text-[11px] tabular-nums",
          selected
            ? "border-[#6e5bff]/50 bg-[#6e5bff]/15 text-[#d9d4ff]"
            : "border-[#343434] bg-[#1b1b1b] text-zinc-500",
        )}
      >
        {index + 1}
      </span>
      <span className="min-w-0 break-words">
        <span className="block text-sm text-[#f3f3f3]">{option.label}</span>
        {note ? <span className="mt-0.5 block text-xs leading-4 text-zinc-500">{note}</span> : null}
      </span>
    </button>
  );
}

function useQuestionPopupPlace(anchor: HTMLElement | null): QuestionPopupPlace | null {
  const [place, setPlace] = useState<QuestionPopupPlace | null>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  useLayoutEffect(() => {
    const node = anchorRef.current;
    if (!node) {
      setPlace(null);
      return;
    }
    const update = () => {
      const current = anchorRef.current;
      if (!current) return;
      const rect = current.getBoundingClientRect();
      const column = current.closest("[data-chat-column]");
      const header = column?.querySelector("[data-chat-header]");
      const ceiling = header instanceof HTMLElement ? header.getBoundingClientRect().bottom + 8 : 8;
      const next = placeQuestionPopup(
        { left: rect.left, top: rect.top, width: rect.width },
        { width: window.innerWidth, height: window.innerHeight },
        ceiling,
      );
      setPlace((previous) =>
        previous &&
        previous.left === next.left &&
        previous.width === next.width &&
        previous.bottom === next.bottom &&
        previous.maxHeight === next.maxHeight
          ? previous
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    const column = node.closest("[data-chat-column]");
    if (column) observer.observe(column);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor]);
  return place;
}
