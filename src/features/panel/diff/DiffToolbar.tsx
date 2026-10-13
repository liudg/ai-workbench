import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight, Ellipsis, Expand, FileSearch, PanelRight, RotateCw, WrapText } from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { diffMenuEntries } from "./diff-menu";
import type { DiffScopeItem } from "./scope";
import { DIFF_TOOLBAR_ICON_IDS, type DiffToolbarIconId } from "./toolbar-actions";
import { SplitDiffIcon } from "./toolbar-icons";

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
  filesOpen,
  onToggleFiles,
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
  filesOpen: boolean;
  onToggleFiles: () => void;
}) {
  const [menu, setMenu] = useState<"scope" | "options" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionsAnchorRef = useRef<HTMLSpanElement>(null);
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
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-diff-options-menu]")) return;
      setMenu(null);
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
      <div className="ml-auto flex shrink-0 items-center">
        {DIFF_TOOLBAR_ICON_IDS.map((id) =>
          id === "options" ? (
            <span key={id} ref={optionsAnchorRef} className="inline-flex">
              <IconButton
                id={id}
                label={DESKTOP_ZH.diffOptions}
                expanded={menu === "options"}
                menu
                onClick={() => setMenu((value) => (value === "options" ? null : "options"))}
              >
                <Ellipsis className="h-3.5 w-3.5" />
              </IconButton>
              {menu === "options" ? (
                <OptionsMenu anchorRef={optionsAnchorRef} checked={checked} onRun={run} />
              ) : null}
            </span>
          ) : (
            <IconButton
              key={id}
              id={id}
              label={iconLabel(id)}
              pressed={iconPressed(id, { loadFull, wrap, expanded, unified, filesOpen })}
              onClick={() => {
                if (id === "files") onToggleFiles();
                else run(id);
              }}
            >
              <ToolbarGlyph id={id} />
            </IconButton>
          ),
        )}
      </div>
    </div>
  );
}

function iconLabel(id: Exclude<DiffToolbarIconId, "options">): string {
  if (id === "load-full") return DESKTOP_ZH.diffLoadFull;
  if (id === "refresh") return DESKTOP_ZH.diffRefresh;
  if (id === "wrap") return DESKTOP_ZH.diffWrap;
  if (id === "expand") return DESKTOP_ZH.diffExpand;
  if (id === "unified") return DESKTOP_ZH.diffUnified;
  return DESKTOP_ZH.filesHideSidebar;
}

function iconPressed(
  id: Exclude<DiffToolbarIconId, "options">,
  state: { loadFull: boolean; wrap: boolean; expanded: boolean; unified: boolean; filesOpen: boolean },
): boolean {
  if (id === "load-full") return state.loadFull;
  if (id === "wrap") return state.wrap;
  if (id === "expand") return state.expanded;
  if (id === "unified") return !state.unified;
  if (id === "files") return state.filesOpen;
  return false;
}

function ToolbarGlyph({ id }: { id: Exclude<DiffToolbarIconId, "options"> }) {
  if (id === "load-full") return <FileSearch className="h-3.5 w-3.5" />;
  if (id === "refresh") return <RotateCw className="h-3.5 w-3.5" />;
  if (id === "wrap") return <WrapText className="h-3.5 w-3.5" />;
  if (id === "expand") return <Expand className="h-3.5 w-3.5" />;
  if (id === "unified") return <SplitDiffIcon />;
  return <PanelRight className="h-3.5 w-3.5" />;
}

function IconButton({
  id,
  label,
  pressed,
  expanded,
  menu,
  onClick,
  children,
}: {
  id: DiffToolbarIconId;
  label: string;
  pressed?: boolean;
  expanded?: boolean;
  menu?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-diff-action={id}
      data-diff-options={menu ? "" : undefined}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-haspopup={menu ? "menu" : undefined}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-800 hover:text-white"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function OptionsMenu({
  anchorRef,
  checked,
  onRun,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  checked: Record<string, boolean>;
  onRun: (id: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const rect = anchor.getBoundingClientRect();
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      let left = rect.right - width;
      left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
      let top = rect.bottom + 4;
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;
    };
    place();
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-diff-options-menu
      className="fixed z-[80] w-max min-w-56 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
      style={{ top: -9999, left: 8 }}
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
              onRun(entry.id);
            }}
          >
            <span className="min-w-0 flex-1">{entry.label}</span>
            {entry.kind === "check" && checked[entry.id] ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
