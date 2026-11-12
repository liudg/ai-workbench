import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { sameChatScope } from "../chat-scope";
import type { Session } from "@/types";
import { approvalKeyAction, releaseOwnedApproval, takeApproval, type ApprovalGate } from "./approval-keys";
import { ChoiceCard } from "./ApprovalCard";
import type { PlanChoicePrompt } from "./pending-plan-choice";
import { useAnswerPrompt } from "./useAnswerPrompt";

/**
 * 计划完成后的确认，浮在作曲栏上方。
 * 选项来自适配器。Esc 选 deny（留在计划模式）。输入框里的文字仍是计划反馈，不在这里拦截。
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
  const rootRef = useRef<HTMLElement>(null);
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
  const denyId = event.options.find((option) => option.slot === "deny" && !option.disabled_reason)?.id;

  useEffect(() => {
    gate.current = { busy: false };
    setBusy(false);
  }, [event.prompt_id]);

  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      const target = keyEvent.target;
      if (!(target instanceof Element)) return;
      if (!sameChatScope(rootRef.current, target)) return;
      const action = approvalKeyAction({
        key: keyEvent.key,
        composing: keyEvent.isComposing,
        keyCode: keyEvent.keyCode,
        defaultPrevented: keyEvent.defaultPrevented,
        inDialog: target.closest("[role='dialog'],[role='menu']") != null,
        onButton: target.closest("button,a") != null,
        inField: target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])") != null,
      });
      if (action !== "deny" || !denyId) return;
      keyEvent.preventDefault();
      chooseRef.current(denyId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [denyId]);

  return (
    <section
      ref={rootRef}
      data-plan-choice-surface
      aria-busy={busy}
      className="mb-2 overflow-hidden rounded-2xl border border-wb-border-strong bg-wb-elev px-4 py-4 shadow-[var(--wb-composer-shadow)]"
    >
      <p className="break-words text-sm font-medium leading-6 text-wb-fg">{event.question}</p>
      {event.subtitle ? (
        <p className="mt-1 break-words text-xs leading-5 text-wb-fg-2">{event.subtitle}</p>
      ) : null}
      <div className={cn("mt-3", busy && "pointer-events-none opacity-60")}>
        <ChoiceCard
          event={event}
          session={session}
          resolvedAnswer={null}
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
