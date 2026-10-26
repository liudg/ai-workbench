// 新会话用哪个 Agent。会话建好后锁定，只能在同一 Agent 里换模型。
// 照 t3code `apps/web/src/components/chat/ModelPickerSidebar.tsx` 的 Provider 列表，
// 锁定照 `apps/web/src/components/ChatView.tsx` 的 `modelPickerLockedProvider`。

import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import type { AgentIdentity } from "@/shared/agent/identity";
import { cn } from "@/lib/utils";
import type { AgentKind } from "@/types";
import { useComposerMenu } from "./useComposerMenu";

const CARD_SHADOW = "0 1px 2px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.04)";
const CARD_BG = "linear-gradient(180deg, #1c1c1f 0%, #17171a 100%)";
const CARD_BG_HOT = "linear-gradient(180deg, #242428 0%, #1e1e22 100%)";

export interface AgentOption {
  kind: AgentKind;
  identity: AgentIdentity | null;
  name: string;
}

export function AgentPicker({
  options,
  selected,
  disabled,
  onPick,
}: {
  /** 还没检测完本机 Agent 时为 null。 */
  options: AgentOption[] | null;
  selected: AgentKind;
  disabled: boolean;
  onPick: (agent: AgentKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useComposerMenu(open, anchorRef, menuRef, close, options?.length);
  const current = options?.find((option) => option.kind === selected);
  const lifted = open || hot;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-[10px] border py-1 pl-1.5 pr-2.5 text-[13px] leading-5 text-[#ececef] disabled:cursor-not-allowed disabled:opacity-60"
        style={{
          backgroundImage: lifted ? CARD_BG_HOT : CARD_BG,
          borderColor: lifted ? "#3a3a42" : "#2e2e33",
          boxShadow: CARD_SHADOW,
        }}
        aria-label={`Agent：${current?.name ?? selected}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-agent-picker={selected}
        disabled={disabled}
        onMouseEnter={() => setHot(true)}
        onMouseLeave={() => setHot(false)}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <SessionAgentIcon identity={current?.identity ?? null} className="h-4 w-4" />
        <span className="min-w-0 truncate">{current?.name ?? selected}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#9a9aa0]" strokeWidth={1.5} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="选择 Agent"
          data-agent-menu=""
          className="fixed z-50 min-w-[200px] overflow-hidden rounded-[10px] border border-[#2e2e33] py-1"
          style={{ top: -9999, left: 8, backgroundImage: CARD_BG, boxShadow: CARD_SHADOW }}
        >
          {options === null ? (
            <div className="px-3 py-2 text-sm text-zinc-500">正在检测本地 Agent…</div>
          ) : options.length === 0 ? (
            <div className="px-3 py-2 text-sm text-zinc-400">未检测到能对话的 Agent</div>
          ) : (
            options.map((option) => {
              const checked = option.kind === selected;
              return (
                <button
                  key={option.kind}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  data-agent={option.kind}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-100 hover:bg-white/[0.06]",
                    checked && "bg-white/[0.04]",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    close();
                    if (!checked) onPick(option.kind);
                  }}
                >
                  <SessionAgentIcon identity={option.identity} className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  {checked ? <Check className="h-4 w-4 shrink-0 text-zinc-200" strokeWidth={2} /> : null}
                </button>
              );
            })
          )}
        </div>
      )}
    </>
  );
}
