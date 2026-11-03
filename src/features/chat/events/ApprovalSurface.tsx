import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, FilePen, Globe, Shield, Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { sameChatScope } from "../chat-scope";
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
  const rootRef = useRef<HTMLElement>(null);
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
    // 焦点在另一段聊天里（侧边聊天和主对话同屏）时不抢过来。
    if (!typing && sameChatScope(rootRef.current, active)) {
      primaryRef.current?.focus();
    }
  }, [event.prompt_id]);

  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      const target = keyEvent.target;
      if (!(target instanceof Element)) return;
      // 同屏两段聊天都在等审批时，只答焦点所在的那段。
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
      ref={rootRef}
      data-codex-approval-surface
      className="@container/approval-card mb-2 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-sm"
    >
      <div className="flex min-w-0 flex-col gap-2 px-4 pb-3 pt-4">
        <div role="alert" aria-atomic="true" className="min-w-0">
          {event.header ? (
            <div className="mb-1 flex min-w-0 items-center gap-1.5 text-xs text-zinc-400">
              {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
              <span className="truncate">{event.header}</span>
            </div>
          ) : null}
          <p className="break-words text-sm font-medium leading-6 text-zinc-100">{event.question}</p>
          {event.subtitle ? (
            <p className="mt-1 break-words text-xs leading-5 text-zinc-400">{event.subtitle}</p>
          ) : null}
        </div>
        {event.reason ? (
          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-sm">
            <div className="text-zinc-500">原因</div>
            <div className="min-w-0 break-words text-zinc-200">{event.reason}</div>
          </div>
        ) : null}
      </div>
      {event.body ? (
        <div className="px-3 pb-1">
          <div
            className={cn(
              "overflow-hidden rounded-md bg-zinc-950/80 text-xs text-zinc-300",
              event.body_kind === "files" ? "max-h-[200px] overflow-y-auto" : "",
            )}
          >
            <pre
              ref={bodyRef}
              className={cn(
                "whitespace-pre-wrap break-words px-2 py-2 font-mono",
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
              <span className="@max-md/approval-card:hidden rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">
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
                  <span className="@max-md/approval-card:hidden rounded bg-white/15 px-1 text-[10px]">Enter</span>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  aria-label="审批选项"
                  aria-expanded={menuOpen}
                  aria-controls={menuId}
                  className="rounded-l-none border-l border-white/20 px-1.5"
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                {menuOpen ? (
                  <div
                    id={menuId}
                    role="menu"
                    className="absolute bottom-full right-0 z-20 mb-1 min-w-44 rounded-md border border-zinc-700 bg-zinc-900 p-1 shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full rounded px-2 py-1.5 text-left text-sm text-zinc-100 hover:bg-zinc-800"
                      onClick={approve}
                    >
                      {slots.primary.label}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      title={slots.scoped.tooltip || undefined}
                      className="block w-full rounded px-2 py-1.5 text-left text-sm text-zinc-100 hover:bg-zinc-800"
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
                <span className="@max-md/approval-card:hidden rounded bg-white/15 px-1 text-[10px]">Enter</span>
              </Button>
            )
          ) : null}
        </div>
      </form>
    </section>
  );
}
