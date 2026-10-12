import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Ellipsis } from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { diffMenuEntries } from "./diff-menu";
import type { DiffScopeItem } from "./scope";

export function DiffToolbar({
  scope,
  scopes,
  onScope,
  added,
  removed,
  expanded,
  onToggleExpanded,
  unified,
  onToggleUnified,
  wrap,
  onToggleWrap,
  onRefresh,
  loadFull,
  onToggleLoadFull,
  renderPreview,
  onToggleRenderPreview,
  wordDiff,
  onToggleWordDiff,
  hideWs,
  onToggleHideWs,
  hideImports,
  onToggleHideImports,
}: {
  scope: string;
  scopes: DiffScopeItem[];
  onScope: (id: string) => void;
  added: number;
  removed: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  unified: boolean;
  onToggleUnified: () => void;
  wrap: boolean;
  onToggleWrap: () => void;
  onRefresh: () => void;
  loadFull: boolean;
  onToggleLoadFull: () => void;
  renderPreview: boolean;
  onToggleRenderPreview: () => void;
  wordDiff: boolean;
  onToggleWordDiff: () => void;
  hideWs: boolean;
  onToggleHideWs: () => void;
  hideImports: boolean;
  onToggleHideImports: () => void;
}) {
  const [menu, setMenu] = useState<"scope" | "options" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = scopes.find((item) => item.id === scope) ?? scopes[0];
  const checked: Record<string, boolean> = {
    "load-full": loadFull,
    render: renderPreview,
    word: wordDiff,
    wrap,
    unified,
    expand: expanded,
    "hide-space": hideWs,
    "hide-imports": hideImports,
  };
  const run = (id: string) => {
    if (id === "refresh") onRefresh();
    if (id === "wrap") onToggleWrap();
    if (id === "unified") onToggleUnified();
    if (id === "expand") onToggleExpanded();
    if (id === "load-full") onToggleLoadFull();
    if (id === "render") onToggleRenderPreview();
    if (id === "word") onToggleWordDiff();
    if (id === "hide-space") onToggleHideWs();
    if (id === "hide-imports") onToggleHideImports();
  };
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
          {current?.label ?? ""}
          <ChevronDown className="h-3 w-3 shrink-0 text-zinc-400" />
        </button>
        {menu === "scope" ? (
          <div
            role="menu"
            data-diff-scope-menu
            className="absolute left-0 top-full z-20 mt-1 w-40 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
          >
            {scopes.map((item) => (
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
      <div className="relative ml-auto shrink-0">
        <button
          type="button"
          data-diff-options
          title={DESKTOP_ZH.diffOptions}
          aria-label={DESKTOP_ZH.diffOptions}
          aria-expanded={menu === "options"}
          aria-haspopup="menu"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-800 hover:text-white"
          onClick={() => setMenu((value) => (value === "options" ? null : "options"))}
        >
          <Ellipsis className="h-3.5 w-3.5" />
        </button>
        {menu === "options" ? (
          <div
            role="menu"
            data-diff-options-menu
            className="absolute right-0 top-full z-20 mt-1 w-max min-w-56 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
          >
            {diffMenuEntries().map((entry) =>
              entry.kind === "separator" ? (
                <div key={entry.id} role="separator" className="my-1 h-px bg-zinc-700" />
              ) : (
                <button
                  key={entry.id}
                  type="button"
                  role={entry.kind === "check" ? "menuitemcheckbox" : "menuitem"}
                  aria-checked={entry.kind === "check" ? checked[entry.id] : undefined}
                  disabled={entry.kind === "disabled"}
                  aria-disabled={entry.kind === "disabled" || undefined}
                  data-diff-option={entry.label}
                  data-diff-copy-apply={entry.id === "copy-apply" ? "" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-xs",
                    entry.kind === "disabled" ? "cursor-default text-zinc-500" : "text-zinc-100 hover:bg-zinc-800",
                  )}
                  onClick={() => {
                    if (entry.kind === "disabled") return;
                    run(entry.id);
                  }}
                >
                  <span className="min-w-0 flex-1">{entry.label}</span>
                  {entry.kind === "check" && checked[entry.id] ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                </button>
              ),
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
