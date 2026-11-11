import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, FilePen, Globe, Shield, Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { approvalKeyAction, releaseOwnedApproval, takeApproval, type ApprovalGate } from "./approval-keys";
import { useAnswerPrompt } from "./useAnswerPrompt";
import { approvalSlots, type ApprovalPrompt } from "./pending-approval";

function headerIcon(header: string) {
  if (header === "终端" || header === "command") return Terminal;
  if (header === "互联网访问") return Globe;
  if (header === "编辑文件") return FilePen;
  if (header === "权限") return Shield;
  return null;
}

export function ApprovalSurface({
  event,
  sessionId,
}: {
  event: ApprovalPrompt;
  sessionId: string;
}) {
  const answerPrompt = useAnswerPrompt();
  const slots = approvalSlots(event.options);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLPreElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [busy, setBusy] = useState(false);
  const gate = useRef<ApprovalGate>({ busy: false });
  const menuId = useId();
  const choose = (id: string | undefined) => {
    const owned = gate.current;
    if (!id || !takeApproval(owned)) return;
    setBusy(true);
    setMenuOpen(false);
    const reopen = () => {
      if (!releaseOwnedApproval(gate.current, owned)) return;
      setBusy(false);
    };
    void Promise.resolve(answerPrompt(sessionId, event.prompt_id, { type: "single", value: id }))
      .then((ok) => {
        if (ok === false) reopen();
      })
      .catch(reopen);
  };
  const approve = () => choose(slots.primary?.id);
  const deny = () => choose(slots.deny?.id);
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  useEffect(() => {
    gate.current = { busy: false };
    setBusy(false);
    const active = document.activeElement;
    const typing =
      active instanceof Element &&
      active.closest("input, textarea, [contenteditable]:not([contenteditable='false'])") != null;
    if (!typing) primaryRef.current?.focus();
  }, [event.prompt_id]);

  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      const target = keyEvent.target;
      if (!(target instanceof Element)) return;
      const action = approvalKeyAction({
        key: keyEvent.key,
        composing: keyEvent.isComposing,
        keyCode: keyEvent.keyCode,
        defaultPrevented: keyEvent.defaultPrevented,
        inDialog: target.closest("[role='dialog'],[role='menu']") != null,
        onButton: target.closest("button,a") != null,
        inField: target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])") != null,
      });
      if (action === "none") return;
      keyEvent.preventDefault();
      const current = slotsRef.current;
      chooseRef.current(action === "deny" ? current.deny?.id : current.primary?.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (pointerEvent: PointerEvent) => {
      if (!menuRef.current?.contains(pointerEvent.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node || event.body_kind === "files") {
      setOverflows(false);
      return;
    }
    const clamped = node.classList.contains("line-clamp-3");
    if (clamped) node.classList.remove("line-clamp-3");
    const full = node.scrollHeight;
    const line = Number.parseFloat(getComputedStyle(node).lineHeight) || 16;
    if (clamped) node.classList.add("line-clamp-3");
    setOverflows(full > line * 3 + 1);
  }, [event.body, event.body_kind, event.prompt_id, expanded]);

  const Icon = headerIcon(event.header ?? "");
  const commandBody = event.body_kind !== "files";

  return (
    <section
      data-codex-approval-surface
      className="@container/approval-card mx-4 mb-2 overflow-hidden rounded-2xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] text-[var(--wb-text)] shadow-[var(--wb-float-shadow)]"
    >
      <div className="flex min-w-0 flex-col gap-2 px-4 pb-3 pt-4">
        <div role="alert" aria-atomic="true" className="min-w-0">
          {event.header ? (
            <div className="mb-1 flex min-w-0 items-center gap-1.5 text-xs text-[var(--wb-muted)]">
              {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
              <span className="truncate">{event.header}</span>
            </div>
          ) : null}
          <p className="break-words text-sm font-medium leading-6 text-[var(--wb-text-strong)]">
            {event.question}
          </p>
          {event.subtitle ? (
            <p className="mt-1 break-words text-xs leading-5 text-[var(--wb-muted)]">
              {event.subtitle}
            </p>
          ) : null}
        </div>
        {event.reason ? (
          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-sm">
            <div className="text-[var(--wb-muted)]">原因</div>
            <div className="min-w-0 break-words text-[var(--wb-text-strong)]">{event.reason}</div>
          </div>
        ) : null}
      </div>
      {event.body ? (
        <div className="px-4 pb-1">
          <div
            className={cn(
              "overflow-hidden rounded-xl border border-[var(--wb-border)] bg-[var(--wb-code-bg)] text-xs text-[var(--wb-text)]",
              event.body_kind === "files" ? "max-h-[200px] overflow-y-auto" : "",
            )}
          >
            <pre
              ref={bodyRef}
              className={cn(
                "whitespace-pre-wrap break-words px-3 py-2 font-mono",
                commandBody && !expanded && "line-clamp-3",
              )}
            >
              {event.body}
            </pre>
            {commandBody && (overflows || expanded) ? (
              <div className="flex justify-end p-1">
                <Button type="button" size="xs" variant="ghost" onClick={() => setExpanded((open) => !open)}>
                  {expanded ? "折叠" : "展开"}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <form
        className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-4 pt-2"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          approve();
        }}
      >
        {slots.leading ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            title={slots.leading.tooltip || undefined}
            onClick={() => choose(slots.leading?.id)}
          >
            <span className="max-w-40 truncate">{slots.leading.label}</span>
          </Button>
        ) : null}
        <div className="ms-auto flex min-w-0 items-center gap-2">
          {slots.deny ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={deny}>
              {slots.deny.label}
              <span className="@max-md/approval-card:hidden rounded bg-[var(--wb-chip)] px-1 text-[10px] text-[var(--wb-muted)]">
                Esc
              </span>
            </Button>
          ) : null}
          {slots.primary ? (
            slots.scoped ? (
              <div ref={menuRef} className="relative flex min-w-0">
                <Button
                  ref={primaryRef}
                  type="submit"
                  size="sm"
                  disabled={busy}
                  className="rounded-r-none"
                >
                  <span className="max-w-40 truncate">{slots.primary.label}</span>
                  <span className="@max-md/approval-card:hidden rounded bg-current/12 px-1 text-[10px]">Enter</span>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  aria-label="审批选项"
                  aria-expanded={menuOpen}
                  aria-controls={menuId}
                  className="rounded-l-none border-l border-current/20 px-1.5"
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                {menuOpen ? (
                  <div
                    id={menuId}
                    role="menu"
                    className="absolute bottom-full right-0 z-20 mb-1 min-w-44 rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] p-1 shadow-[var(--wb-float-shadow)]"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--wb-text-strong)] transition-colors hover:bg-[var(--wb-hover)]"
                      onClick={approve}
                    >
                      {slots.primary.label}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      title={slots.scoped.tooltip || undefined}
                      className="block w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--wb-text-strong)] transition-colors hover:bg-[var(--wb-hover)]"
                      onClick={() => choose(slots.scoped?.id)}
                    >
                      {slots.scoped.label}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <Button ref={primaryRef} type="submit" size="sm" disabled={busy}>
                {slots.primary.label}
                <span className="@max-md/approval-card:hidden rounded bg-current/12 px-1 text-[10px]">Enter</span>
              </Button>
            )
          ) : null}
        </div>
      </form>
    </section>
  );
}
