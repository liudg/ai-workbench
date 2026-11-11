import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PromptQuestion, SessionEvent } from "@/types";
import { questionFocusRequest } from "./question-popup-place";
import { useQuestionPopupPlace } from "./useQuestionPopupPlace";
import {
  continueQuestionStep,
  createQuestionStep,
  dismissQuestionStep,
  focusQuestionFreeform,
  highlightQuestionOption,
  optionPresentation,
  pageQuestion,
  questionChoiceText,
  questionKeyAction,
  questionPopupPrimary,
  questionPopupTitle,
  questionStepCursor,
  questionSurface,
  selectQuestionOption,
  setQuestionFreeform,
  skipQuestionStep,
  type QuestionKeyFocus,
  type QuestionStepEffect,
  type QuestionStepState,
} from "./question-steps";
import { useAnswerPrompt } from "./useAnswerPrompt";

/**
 * 提问浮在作曲栏上方，所有 Agent 共用。
 * 文案和步进来自 Codex 桌面端 request input / sendUserMessageQuestion。
 * 回答仍走 answerPrompt。
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
  const questions = event.questions;
  const [step, setStep] = useState<QuestionStepState>(() => createQuestionStep(questions));
  const [closed, setClosed] = useState(false);
  const lock = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const freeformRef = useRef<HTMLInputElement>(null);
  const cursor = questionStepCursor(step, questions.length);
  const question = questions[cursor.index];
  const choice = step.choices[cursor.index];
  const surface = questionSurface(questions);

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

  const showOptions = (question?.options.length ?? 0) > 0;
  const showOther = showOptions && question?.is_other === true;
  const showFreeform = !showOptions;
  const focus = questionFocusRequest({
    placed: place != null,
    closed,
    hasQuestion: Boolean(question && choice),
    freeform: showFreeform,
  });
  useEffect(() => {
    if (focus === "freeform") freeformRef.current?.focus();
    else if (focus === "card") cardRef.current?.focus();
  }, [focus, question?.id]);

  if (!question || !choice || !place || closed || typeof document === "undefined") return null;

  const title = questionPopupTitle(surface, question.header ?? "", question.question);
  const showBody = surface === "async-reply" || Boolean(question.header?.trim());
  const placeholder = freeformPlaceholder(surface, question.is_other === true);
  const primary = questionPopupPrimary(surface, cursor.isLast);
  const answerText = questionChoiceText(question, choice);
  const canPrimary = surface !== "async-reply" || answerText.length > 0;
  const selectedIndex = question.options.findIndex((option) => option.id === choice.selectedId);

  const onKeyDown = (keyEvent: KeyboardEvent<HTMLDivElement>) => {
    const target = keyEvent.target;
    const focus: QuestionKeyFocus =
      target instanceof Element && target.closest("[data-request-input-dismiss]")
        ? "dismiss"
        : target === freeformRef.current
          ? "freeform"
          : target instanceof Element && target.closest("input, textarea")
            ? "field"
            : "card";
    const action = questionKeyAction({
      key: keyEvent.key,
      composing: keyEvent.nativeEvent.isComposing,
      keyCode: keyEvent.nativeEvent.keyCode,
      focus,
      questionCount: questions.length,
      questionIndex: cursor.index,
      optionCount: question.options.length,
      selectedIndex,
      isOther: showOther,
      hasOptions: showOptions,
      multi: question.multi_select === true,
    });
    if (action.type === "none") return;
    keyEvent.preventDefault();
    if (action.type === "dismiss") {
      apply(dismissQuestionStep());
      return;
    }
    if (action.type === "page") {
      apply(pageQuestion(step, questions, action.index));
      return;
    }
    if (action.type === "focus-freeform") {
      setStep(focusQuestionFreeform(step, questions));
      freeformRef.current?.focus();
      return;
    }
    if (action.type === "move" || action.type === "select") {
      const option = question.options[action.index];
      if (!option) return;
      const effect =
        action.type === "move"
          ? highlightQuestionOption(step, questions, option.id)
          : selectQuestionOption(step, questions, option.id);
      apply(effect);
      if (action.type === "move") cardRef.current?.focus();
      return;
    }
    apply(continueQuestionStep(step, questions));
  };

  return createPortal(
    <div
      data-question-popup
      data-question-surface={surface}
      role="dialog"
      aria-label={surface === "async-reply" ? "问题" : title}
      className="fixed z-40"
      style={{
        left: place.left,
        width: place.width,
        bottom: place.bottom,
        maxHeight: place.maxHeight,
      }}
    >
      <div
        ref={cardRef}
        tabIndex={0}
        style={{ maxHeight: place.maxHeight }}
        className="select-text overflow-y-auto rounded-2xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] text-[var(--wb-text)] shadow-[var(--wb-float-shadow)] outline-none [&_button]:select-none"
        onKeyDown={onKeyDown}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 bg-[var(--wb-elev)] px-4 pb-2 pt-4">
          <p className="min-w-0 break-words text-sm font-medium text-[var(--wb-text-strong)]">{title}</p>
          <div className="flex shrink-0 items-center gap-1 text-xs text-[var(--wb-faint)]">
            {questions.length > 1 ? (
              <>
                <button
                  type="button"
                  aria-label="上一个问题"
                  disabled={cursor.index === 0}
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--wb-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)] disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => apply(pageQuestion(step, questions, cursor.index - 1))}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="tabular-nums">
                  {cursor.index + 1} / {questions.length}
                </span>
                <button
                  type="button"
                  aria-label="下一个问题"
                  disabled={cursor.isLast}
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--wb-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)] disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => apply(pageQuestion(step, questions, cursor.index + 1))}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </>
            ) : null}
            <button
              type="button"
              aria-label="关闭"
              data-question-close
              data-request-input-dismiss
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--wb-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]"
              onKeyDown={(keyEvent) => {
                if (keyEvent.key === "Enter") keyEvent.stopPropagation();
              }}
              onClick={() => apply(dismissQuestionStep())}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {showBody ? (
          <p className="break-words whitespace-pre-wrap px-4 text-sm font-medium text-[var(--wb-text-strong)]">
            {question.question}
          </p>
        ) : null}
        {question.description?.trim() ? (
          <p className="mt-1 break-words whitespace-pre-wrap px-4 text-sm text-[var(--wb-muted)]">
            {question.description}
          </p>
        ) : null}
        <div className="flex flex-col gap-1 px-2 py-2">
          {showOptions ? (
            <div
              className="flex flex-col gap-1"
              role={question.multi_select ? "group" : "radiogroup"}
              aria-label={question.question}
            >
              {question.options.map((option, index) => (
                <OptionRow
                  key={option.id}
                  index={index}
                  option={option}
                  multi={question.multi_select === true}
                  showNumber={question.options.length > 1}
                  selected={
                    question.multi_select
                      ? choice.selectedIds.includes(option.id)
                      : choice.selectedId === option.id
                  }
                  onPick={() => apply(selectQuestionOption(step, questions, option.id))}
                />
              ))}
            </div>
          ) : null}
          {showFreeform ? (
            <input
              ref={freeformRef}
              key={question.id}
              value={choice.freeform}
              onChange={(change) => setStep(setQuestionFreeform(step, questions, change.target.value))}
              placeholder={placeholder}
              autoComplete="off"
              className="min-h-10 w-full bg-transparent px-2 py-2 text-sm text-[var(--wb-text-strong)] outline-none placeholder:text-[var(--wb-faint)]"
            />
          ) : null}
          <div className={cn("flex items-center gap-2", showOther && "rounded-xl px-2 py-1.5 focus-within:ring-1 focus-within:ring-[var(--wb-border-strong)]")}>
            {showOther ? (
              <input
                ref={freeformRef}
                key={`${question.id}-other`}
                data-request-input-other-row
                value={choice.freeform}
                onChange={(change) => setStep(setQuestionFreeform(step, questions, change.target.value))}
                onFocus={() => setStep(focusQuestionFreeform(step, questions))}
                placeholder={placeholder}
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-[var(--wb-text-strong)] outline-none placeholder:text-[var(--wb-faint)]"
              />
            ) : (
              <span className="flex-1" />
            )}
            <button
              type="button"
              data-question-skip
              data-request-input-dismiss
              className="h-8 shrink-0 cursor-pointer rounded-full border border-[var(--wb-border-strong)] bg-transparent px-3 text-sm text-[var(--wb-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]"
              onKeyDown={(keyEvent) => {
                if (keyEvent.key === "Enter") keyEvent.stopPropagation();
              }}
              onClick={() => apply(skipQuestionStep(step, questions))}
            >
              跳过
            </button>
            <button
              type="button"
              data-question-primary
              disabled={!canPrimary}
              className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-[var(--wb-send-bg)] px-3.5 text-sm font-medium text-[var(--wb-send-fg)] hover:opacity-90 disabled:cursor-not-allowed disabled:bg-[var(--wb-send-disabled-bg)] disabled:text-[var(--wb-send-disabled-fg)]"
              onClick={() => apply(continueQuestionStep(step, questions))}
            >
              <span>{primary}</span>
              {surface === "request-input" ? <span aria-hidden="true">⏎</span> : null}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function freeformPlaceholder(surface: "request-input" | "async-reply", isOther: boolean): string {
  if (surface === "async-reply") return isOther ? "或自行撰写回复" : "回复…";
  return isOther ? "否，并说明其他想法" : "在此输入";
}

function OptionRow({
  index,
  option,
  multi,
  showNumber,
  selected,
  onPick,
}: {
  index: number;
  option: PromptQuestion["options"][number];
  multi: boolean;
  showNumber: boolean;
  selected: boolean;
  onPick: () => void;
}) {
  const disabled = Boolean(option.disabled_reason);
  const presented = optionPresentation(option.label);
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      data-question-option={index + 1}
      className={cn(
        "flex w-full min-w-0 items-start gap-2.5 rounded-xl px-2 py-2 text-left transition-colors",
        disabled
          ? "cursor-not-allowed opacity-50"
          : selected
            ? "cursor-pointer bg-[var(--wb-hover-strong)]"
            : "cursor-pointer hover:bg-[var(--wb-hover)]",
      )}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPick}
    >
      {multi ? (
        <span
          className={cn(
            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border text-[10px]",
            selected
              ? "border-[var(--wb-send-bg)] bg-[var(--wb-send-bg)] text-[var(--wb-send-fg)]"
              : "border-[var(--wb-border-strong)] text-transparent",
          )}
          aria-hidden="true"
        >
          ✓
        </span>
      ) : showNumber ? (
        <span
          className={cn(
            "mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-[11px] tabular-nums",
            selected
              ? "bg-[var(--wb-chip-hover)] text-[var(--wb-text-strong)]"
              : "bg-[var(--wb-chip)] text-[var(--wb-muted)]",
          )}
        >
          {index + 1}
        </span>
      ) : null}
      <span className="min-w-0 break-words">
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-[var(--wb-text-strong)]">{presented.label}</span>
          {presented.recommended ? (
            <span className="rounded-md bg-[var(--wb-chip)] px-1.5 py-0.5 text-xs text-[var(--wb-muted)]">推荐</span>
          ) : null}
        </span>
        {option.description || option.disabled_reason ? (
          <span className="mt-0.5 block text-sm text-[var(--wb-muted)]">
            {option.disabled_reason || option.description}
          </span>
        ) : null}
      </span>
    </button>
  );
}
