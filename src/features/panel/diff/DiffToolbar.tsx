import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Ellipsis,
  Expand,
  FileSearch,
  FileText,
  Folder,
  Image as ImageIcon,
  Import as ImportIcon,
  Pilcrow,
  RotateCw,
  Search,
  WholeWord,
  WrapText,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { diffMenuEntries, type DiffMenuIcon } from "./diff-menu";
import { writeClipboardText } from "./git-apply";
import { filterJumpFiles, jumpFileParts, type JumpFile } from "./jump-files";
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
  layoutSplit,
  onToggleLayout,
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
  jumpFiles,
  activePath,
  onJump,
  copyCommand,
  copyReason,
}: {
  scope: string;
  scopes: DiffScopeItem[];
  onScope: (id: string) => void;
  added: number;
  removed: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  layoutSplit: boolean;
  onToggleLayout: () => void;
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
  jumpFiles: readonly JumpFile[];
  activePath: string;
  onJump: (path: string) => void;
  copyCommand: string | null;
  copyReason: string;
}) {
  const [menu, setMenu] = useState<"scope" | "options" | "jump" | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const optionsAnchorRef = useRef<HTMLSpanElement>(null);
  const jumpAnchorRef = useRef<HTMLSpanElement>(null);
  const current = scopes.find((item) => item.id === scope) ?? scopes[0];
  const checked: Record<string, boolean> = {
    "load-full": loadFull,
    render: renderPreview,
    word: wordDiff,
    "hide-space": hideWs,
    "hide-imports": hideImports,
  };
  const entries = diffMenuEntries({ enabled: Boolean(copyCommand), reason: copyReason });
  const run = (id: string) => {
    if (id === "load-full") onToggleLoadFull();
    if (id === "render") onToggleRenderPreview();
    if (id === "word") onToggleWordDiff();
    if (id === "hide-space") onToggleHideWs();
    if (id === "hide-imports") onToggleHideImports();
  };
  const copyApply = async () => {
    if (!copyCommand) return;
    try {
      await writeClipboardText(copyCommand);
      setCopyStatus(DESKTOP_ZH.diffCopied);
      setMenu(null);
    } catch (error: unknown) {
      const message = error instanceof Error && error.message.trim() ? error.message : DESKTOP_ZH.diffCopyFailed;
      setCopyStatus(message);
    }
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
      if (target instanceof Element && target.closest("[data-diff-options-menu], [data-diff-jump-popover]")) return;
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
      className="relative z-20 flex h-9 min-w-0 shrink-0 flex-nowrap items-center gap-1 border-b border-zinc-800 bg-zinc-950 px-1.5"
    >
      {scopes.length > 0 ? <div className="relative shrink-0">
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
      </div> : null}
      <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-emerald-400">+{added}</span>
      <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-red-400">-{removed}</span>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {DIFF_TOOLBAR_ICON_IDS.map((id) => {
          if (id === "options") {
            return (
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
              </span>
            );
          }
          if (id === "jump") {
            return (
              <span key={id} ref={jumpAnchorRef} className="inline-flex">
                <IconButton
                  id={id}
                  label={DESKTOP_ZH.diffJump}
                  expanded={menu === "jump"}
                  menu
                  onClick={() => setMenu((value) => (value === "jump" ? null : "jump"))}
                >
                  <FileSearch className="h-3.5 w-3.5" />
                </IconButton>
              </span>
            );
          }
          return (
            <IconButton
              key={id}
              id={id}
              label={iconLabel(id, { layoutSplit, filesOpen })}
              pressed={id === "refresh" ? undefined : iconPressed(id, { wrap, expanded, layoutSplit, filesOpen })}
              onClick={() => {
                if (id === "files") onToggleFiles();
                else if (id === "refresh") onRefresh();
                else if (id === "wrap") onToggleWrap();
                else if (id === "expand") onToggleExpanded();
                else if (id === "layout") onToggleLayout();
              }}
            >
              <ToolbarGlyph id={id} />
            </IconButton>
          );
        })}
      </div>
      {menu === "options" ? (
        <OptionsMenu
          anchorRef={optionsAnchorRef}
          entries={entries}
          checked={checked}
          onRun={run}
          onCopy={() => void copyApply()}
        />
      ) : null}
      {menu === "jump" ? (
        <JumpPopover
          anchorRef={jumpAnchorRef}
          files={jumpFiles}
          activePath={activePath}
          onSelect={(path) => {
            onJump(path);
            setMenu(null);
          }}
        />
      ) : null}
      <p className="sr-only" role="status" data-diff-copy-status={copyStatus || undefined}>
        {copyStatus}
      </p>
    </div>
  );
}

function iconLabel(
  id: Exclude<DiffToolbarIconId, "options" | "jump">,
  state: { layoutSplit: boolean; filesOpen: boolean },
): string {
  if (id === "refresh") return DESKTOP_ZH.diffRefresh;
  if (id === "wrap") return DESKTOP_ZH.diffWrap;
  if (id === "expand") return DESKTOP_ZH.diffExpand;
  if (id === "layout") return state.layoutSplit ? DESKTOP_ZH.diffUnified : DESKTOP_ZH.diffSplit;
  return state.filesOpen ? DESKTOP_ZH.diffHideFile : DESKTOP_ZH.diffShowFile;
}

function iconPressed(
  id: Exclude<DiffToolbarIconId, "options" | "jump">,
  state: { wrap: boolean; expanded: boolean; layoutSplit: boolean; filesOpen: boolean },
): boolean {
  if (id === "wrap") return state.wrap;
  if (id === "expand") return state.expanded;
  if (id === "layout") return state.layoutSplit;
  if (id === "files") return state.filesOpen;
  return false;
}

function ToolbarGlyph({ id }: { id: Exclude<DiffToolbarIconId, "options" | "jump"> }) {
  if (id === "refresh") return <RotateCw className="h-3.5 w-3.5" />;
  if (id === "wrap") return <WrapText className="h-3.5 w-3.5" />;
  if (id === "expand") return <Expand className="h-3.5 w-3.5" />;
  if (id === "layout") return <SplitDiffIcon />;
  return <Folder className="h-3.5 w-3.5" />;
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
      data-diff-options={id === "options" ? "" : undefined}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-haspopup={menu ? "menu" : undefined}
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
        pressed
          ? "bg-sky-200 text-sky-900"
          : expanded
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-300 hover:bg-zinc-800 hover:text-white",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MenuGlyph({ icon }: { icon: DiffMenuIcon }) {
  const className = "h-3.5 w-3.5 shrink-0";
  if (icon === "file") return <FileText className={className} />;
  if (icon === "preview") return <ImageIcon className={className} />;
  if (icon === "word") return <WholeWord className={className} />;
  if (icon === "space") return <Pilcrow className={className} />;
  if (icon === "imports") return <ImportIcon className={className} />;
  return <Clipboard className={className} />;
}

function OptionsMenu({
  anchorRef,
  entries,
  checked,
  onRun,
  onCopy,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  entries: ReturnType<typeof diffMenuEntries>;
  checked: Record<string, boolean>;
  onRun: (id: string) => void;
  onCopy: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useAnchoredLayer(true, anchorRef, menuRef, entries.map((entry) => entry.kind).join(","));
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-diff-options-menu
      className="fixed z-[80] w-max min-w-[232px] rounded-xl border border-black/5 bg-white py-1 text-zinc-800 shadow-[0_12px_32px_rgba(0,0,0,0.16)]"
      style={{ top: -9999, left: 8 }}
    >
      {entries.map((entry) => (
        <span key={entry.id} className="block" title={entry.kind === "disabled" ? entry.reason : undefined}>
          <button
            type="button"
            role={entry.kind === "check" ? "menuitemcheckbox" : "menuitem"}
            aria-checked={entry.kind === "check" ? Boolean(checked[entry.id]) : undefined}
            disabled={entry.kind === "disabled"}
            aria-disabled={entry.kind === "disabled" || undefined}
            aria-label={
              entry.kind === "disabled" && entry.reason ? `${entry.label}（${entry.reason}）` : entry.label
            }
            data-diff-option={entry.label}
            data-diff-copy-apply={entry.id === "copy-apply" ? "" : undefined}
            data-diff-copy-enabled={entry.id === "copy-apply" ? String(entry.kind === "action") : undefined}
            data-diff-copy-reason={entry.id === "copy-apply" ? entry.reason ?? "" : undefined}
            className={cn(
              "flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-[13px]",
              entry.kind === "disabled"
                ? "pointer-events-none cursor-default text-zinc-400"
                : "text-zinc-800 hover:bg-zinc-100",
            )}
            onClick={() => {
              if (entry.kind === "disabled") return;
              if (entry.id === "copy-apply") onCopy();
              else onRun(entry.id);
            }}
          >
            <MenuGlyph icon={entry.icon} />
            <span className="min-w-0 flex-1">{entry.label}</span>
            {entry.kind === "check" && checked[entry.id] ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-zinc-700" />
            ) : (
              <span className="h-3.5 w-3.5 shrink-0" />
            )}
          </button>
        </span>
      ))}
    </div>,
    document.body,
  );
}

function JumpPopover({
  anchorRef,
  files,
  activePath,
  onSelect,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  files: readonly JumpFile[];
  activePath: string;
  onSelect: (path: string) => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(() => Math.max(0, files.findIndex((file) => file.path === activePath)));
  const matches = filterJumpFiles(files, query);
  const activeIndex = matches.length === 0 ? 0 : Math.min(Math.max(cursor, 0), matches.length - 1);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useAnchoredLayer(true, anchorRef, popoverRef, `${query}:${matches.length}`);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={DESKTOP_ZH.diffJump}
      data-diff-jump-popover
      className="fixed z-[80] w-80 overflow-hidden rounded-xl border border-black/5 bg-white text-zinc-900 shadow-[0_12px_32px_rgba(0,0,0,0.16)]"
      style={{ top: -9999, left: 8 }}
    >
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3">
        <Search className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <input
          ref={inputRef}
          value={query}
          placeholder={DESKTOP_ZH.diffJump}
          aria-label={DESKTOP_ZH.diffJump}
          data-diff-jump-input
          className="h-9 w-full bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400"
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (matches.length === 0) return;
              setCursor((value) => Math.min(matches.length - 1, Math.max(0, value) + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const file = matches[activeIndex];
              if (file) onSelect(file.path);
            }
          }}
        />
      </div>
      <div className="max-h-72 overflow-y-auto py-1" role="listbox" aria-label={DESKTOP_ZH.diffJump}>
        {files.length === 0 ? (
          <p className="px-3 py-2 text-sm text-zinc-400">{DESKTOP_ZH.noFileChanges}</p>
        ) : matches.length === 0 ? (
          <p className="px-3 py-2 text-sm text-zinc-400">{DESKTOP_ZH.noFileMatch}</p>
        ) : (
          matches.map((file, index) => {
            const parts = jumpFileParts(file.path);
            return (
              <button
                key={file.path}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                data-diff-jump-file={file.path}
                data-diff-jump-current={file.path === activePath ? "true" : "false"}
                className={cn(
                  "flex w-full min-w-0 items-baseline gap-3 px-3 py-1.5 text-left",
                  index === activeIndex ? "bg-zinc-100" : "hover:bg-zinc-100",
                )}
                onMouseEnter={() => setCursor(index)}
                onClick={() => onSelect(file.path)}
              >
                <span className="shrink-0 text-sm font-medium text-zinc-900">{parts.name}</span>
                {parts.dir ? <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{parts.dir}</span> : null}
              </button>
            );
          })
        )}
      </div>
    </div>,
    document.body,
  );
}

function useAnchoredLayer(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  layerRef: RefObject<HTMLElement | null>,
  revision: string,
) {
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const layer = layerRef.current;
      if (!anchor || !layer) return;
      const rect = anchor.getBoundingClientRect();
      const width = layer.offsetWidth;
      const height = layer.offsetHeight;
      let left = rect.right - width;
      left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
      layer.style.top = `${top}px`;
      layer.style.left = `${left}px`;
    };
    place();
    const frame = requestAnimationFrame(place);
    const observer = layerRef.current ? new ResizeObserver(place) : null;
    if (layerRef.current && observer) observer.observe(layerRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, layerRef, open, revision]);
}
