import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  EyeOff,
  Rows3,
  UnfoldVertical,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { diffScopeMenu } from "./scope";

const SCOPES = diffScopeMenu();

export function DiffToolbar({
  scope,
  onScope,
  added,
  removed,
  expanded,
  onToggleExpanded,
  unified,
  onToggleUnified,
  onJump,
  onHide,
  loadFull,
  onToggleLoadFull,
  renderPreview,
  onToggleRenderPreview,
  wordDiff,
  onToggleWordDiff,
  hideWs,
  onToggleHideWs,
}: {
  scope: string;
  onScope: (id: string) => void;
  added: number;
  removed: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  unified: boolean;
  onToggleUnified: () => void;
  onJump: () => void;
  onHide: () => void;
  loadFull: boolean;
  onToggleLoadFull: () => void;
  renderPreview: boolean;
  onToggleRenderPreview: () => void;
  wordDiff: boolean;
  onToggleWordDiff: () => void;
  hideWs: boolean;
  onToggleHideWs: () => void;
}) {
  const [menu, setMenu] = useState<"scope" | "options" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = SCOPES.find((item) => item.id === scope) ?? SCOPES[0];
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [menu]);

  return (
    <div
      ref={rootRef}
      data-diff-toolbar
      className="relative z-20 flex h-8 min-w-0 shrink-0 flex-nowrap items-center gap-1 border-b border-zinc-800 px-1"
    >
      <div className="relative shrink-0">
        <button
          type="button"
          data-diff-scope
          aria-expanded={menu === "scope"}
          aria-haspopup="menu"
          className="inline-flex h-[22px] items-center gap-0.5 whitespace-nowrap rounded-full bg-zinc-800 px-1.5 text-[11px] text-zinc-100"
          onClick={() => setMenu((value) => (value === "scope" ? null : "scope"))}
        >
          {current.label}
          <ChevronDown className="h-3 w-3 shrink-0 text-zinc-400" />
        </button>
        {menu === "scope" ? (
          <div
            role="menu"
            data-diff-scope-menu
            className="absolute left-0 top-full z-20 mt-1 w-40 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
          >
            {SCOPES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.submenu}
                aria-disabled={item.submenu || undefined}
                data-diff-scope-item={item.id}
                data-submenu={item.submenu ? "true" : "false"}
                className={cn(
                  "flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-xs",
                  item.submenu ? "cursor-default text-zinc-500" : "text-zinc-100 hover:bg-zinc-800",
                )}
                onClick={() => {
                  if (item.submenu) return;
                  onScope(item.id);
                  setMenu(null);
                }}
              >
                <span className="min-w-0 flex-1">{item.label}</span>
                {scope === item.id ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                {item.submenu ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-emerald-400">+{added}</span>
      <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-red-400">-{removed}</span>
      <div className="relative ml-auto flex shrink-0 flex-nowrap items-center rounded-full border border-zinc-800 px-0.5">
        <div>
          <button
            type="button"
            data-diff-options
            title={`${DESKTOP_ZH.changesTab}选项`}
            aria-label={`${DESKTOP_ZH.changesTab}选项`}
            aria-expanded={menu === "options"}
            aria-haspopup="menu"
            className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 hover:text-white"
            onClick={() => setMenu((value) => (value === "options" ? null : "options"))}
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </button>
          {menu === "options" ? (
            <div
              role="menu"
              data-diff-options-menu
              className="absolute right-0 top-full z-20 mt-1 w-52 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
            >
              <OptionRow label={DESKTOP_ZH.diffLoadFull} checked={loadFull} onClick={onToggleLoadFull} />
              <OptionRow label={DESKTOP_ZH.diffRender} checked={renderPreview} onClick={onToggleRenderPreview} />
              <OptionRow label={DESKTOP_ZH.diffWord} checked={wordDiff} onClick={onToggleWordDiff} />
              <OptionRow label={DESKTOP_ZH.diffHideSpace} checked={hideWs} onClick={onToggleHideWs} />
              <button
                type="button"
                role="menuitem"
                disabled
                aria-disabled="true"
                data-diff-copy-apply
                className="flex w-full cursor-default whitespace-nowrap px-3 py-1.5 text-left text-xs text-zinc-500"
              >
                {DESKTOP_ZH.diffCopyApply}
              </button>
            </div>
          ) : null}
        </div>
        <ToolIcon label={DESKTOP_ZH.diffJump} attr="data-diff-jump" onClick={onJump}>
          <ArrowUpRight className="h-3.5 w-3.5" />
        </ToolIcon>
        <ToolIcon
          label={DESKTOP_ZH.diffExpand}
          attr="data-diff-expand"
          pressed={expanded}
          onClick={onToggleExpanded}
        >
          <UnfoldVertical className="h-3.5 w-3.5" />
        </ToolIcon>
        <ToolIcon
          label={DESKTOP_ZH.diffUnified}
          attr="data-diff-unified"
          pressed={unified}
          onClick={onToggleUnified}
        >
          <Rows3 className="h-3.5 w-3.5" />
        </ToolIcon>
        <ToolIcon label={DESKTOP_ZH.diffHideFile} attr="data-diff-hide" onClick={onHide}>
          <EyeOff className="h-3.5 w-3.5" />
        </ToolIcon>
      </div>
    </div>
  );
}

function ToolIcon({
  label,
  attr,
  pressed,
  onClick,
  children,
}: {
  label: string;
  attr: "data-diff-jump" | "data-diff-expand" | "data-diff-unified" | "data-diff-hide";
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      {...{ [attr]: "" }}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        "inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 hover:text-white",
        pressed && "bg-zinc-800 text-zinc-50",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function OptionRow({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      data-diff-option={label}
      className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-xs text-zinc-100 hover:bg-zinc-800"
      onClick={onClick}
    >
      <span className="min-w-0 flex-1">{label}</span>
      {checked ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
    </button>
  );
}
