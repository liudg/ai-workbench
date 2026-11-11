import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { Session } from "@/types";
import { approvalKeyAction, releaseOwnedApproval, takeApproval, type ApprovalGate } from "./approval-keys";
import { ChoiceCard } from "./ApprovalCard";
import type { PlanChoicePrompt } from "./pending-plan-choice";
import { useAnswerPrompt } from "./useAnswerPrompt";

/**
 * 计划完成后的确认，浮在作曲栏上方。
 * 选项来自适配器。Esc 选 deny（留在计划模式）；焦点不在输入框时支持 1-9、上下方向键与回车选择。
 * 输入框里的文字仍是计划反馈，不在这里拦截。
 */
export function PlanChoiceSurface({
  event,
  session,
}: {
  event: PlanChoicePrompt;
  session: Session;
}) {
  const answerPrompt = useAnswerPrompt();
  const [busy, setBusy] = useState(false);
  const enabledIndices = useMemo(
    () =>
      event.options.flatMap((option, index) => (option.disabled_reason ? [] : [index])),
    [event.options],
  );
  const defaultIndex = useMemo(() => {
    const primary = event.options.findIndex(
      (option) => option.slot === "primary" && !option.disabled_reason,
    );
    return primary >= 0 ? primary : (enabledIndices[0] ?? -1);
  }, [enabledIndices, event.options]);
  const [activeIndex, setActiveIndex] = useState<number>(defaultIndex);
  const surfaceRef = useRef<HTMLElement>(null);
  const activate = useCallback((index: number, focus = false) => {
    setActiveIndex(index);
    const surface = surfaceRef.current;
    const optionFocused =
      surface?.contains(document.activeElement) && document.activeElement?.matches("[data-option-id]");
    if (focus || optionFocused) {
      surface?.querySelectorAll<HTMLButtonElement>("[data-option-id]").item(index)?.focus();
    }
  }, []);
  const gate = useRef<ApprovalGate>({ busy: false });
  const choose = (id: string | undefined) => {
    const owned = gate.current;
    if (!id || !takeApproval(owned)) return;
    setBusy(true);
    const reopen = () => {
      if (!releaseOwnedApproval(gate.current, owned)) return;
      setBusy(false);
    };
    void Promise.resolve(answerPrompt(session.id, event.prompt_id, { type: "single", value: id }))
      .then((ok) => {
        if (ok === false) reopen();
      })
      .catch(reopen);
  };
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  const stateRef = useRef({ options: event.options, enabledIndices, activeIndex });
  stateRef.current = { options: event.options, enabledIndices, activeIndex };
  const denyId = event.options.find((option) => option.slot === "deny" && !option.disabled_reason)?.id;

  useEffect(() => {
    gate.current = { busy: false };
    setBusy(false);
    setActiveIndex(defaultIndex);
  }, [event.prompt_id, defaultIndex]);

  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      const target = keyEvent.target;
      if (!(target instanceof Element)) return;
      const inDialog = target.closest("[role='dialog'],[role='menu']") != null;
      const onButton = target.closest("button,a") != null;
      const inField =
        target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])") != null;

      const action = approvalKeyAction({
        key: keyEvent.key,
        composing: keyEvent.isComposing,
        keyCode: keyEvent.keyCode,
        defaultPrevented: keyEvent.defaultPrevented,
        inDialog,
        onButton,
        inField,
      });
      if (action === "deny" && denyId) {
        keyEvent.preventDefault();
        chooseRef.current(denyId);
        return;
      }

      if (
        keyEvent.defaultPrevented ||
        keyEvent.isComposing ||
        keyEvent.keyCode === 229 ||
        inDialog ||
        inField ||
        keyEvent.metaKey ||
        keyEvent.ctrlKey ||
        keyEvent.altKey
      ) {
        return;
      }

      const { options, enabledIndices: enabled, activeIndex: currentActive } = stateRef.current;
      if (/^[1-9]$/.test(keyEvent.key)) {
        const picked = options[Number(keyEvent.key) - 1];
        if (picked && !picked.disabled_reason) {
          keyEvent.preventDefault();
          chooseRef.current(picked.id);
        }
        return;
      }
      if ((keyEvent.key === "ArrowDown" || keyEvent.key === "ArrowUp") && enabled.length > 0) {
        keyEvent.preventDefault();
        const pos = enabled.indexOf(currentActive);
        const nextPos =
          keyEvent.key === "ArrowDown"
            ? pos < 0
              ? 0
              : (pos + 1) % enabled.length
            : pos <= 0
              ? enabled.length - 1
              : pos - 1;
        activate(enabled[nextPos]!, true);
        return;
      }
      if (keyEvent.key === "Enter" && !onButton) {
        const picked = options[currentActive];
        if (picked && !picked.disabled_reason) {
          keyEvent.preventDefault();
          chooseRef.current(picked.id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [denyId, activate]);

  return (
    <section
      ref={surfaceRef}
      data-plan-choice-surface
      aria-busy={busy}
      className="mx-4 mb-2 overflow-hidden rounded-2xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] px-4 py-4 text-[var(--wb-text)] shadow-[var(--wb-float-shadow)]"
    >
      <p className="break-words text-sm font-medium leading-6 text-[var(--wb-text-strong)]">
        {event.question}
      </p>
      {event.subtitle ? (
        <p className="mt-1 break-words text-xs leading-5 text-[var(--wb-muted)]">{event.subtitle}</p>
      ) : null}
      <div className={cn("mt-3", busy && "pointer-events-none opacity-60")}>
        <ChoiceCard
          event={event}
          session={session}
          resolvedAnswer={null}
          activeIndex={activeIndex}
          onActiveIndexChange={activate}
          answerPrompt={(_sessionId, _promptId, answer) => {
            if (answer.type !== "single") return;
            chooseRef.current(answer.value);
          }}
          flush
        />
      </div>
    </section>
  );
}
