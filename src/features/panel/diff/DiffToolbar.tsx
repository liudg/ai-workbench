import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Ellipsis, FileSearch } from "lucide-react";

import { IconButton, iconLabel, iconPressed, ToolbarGlyph } from "./DiffToolbarIcons";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { diffMenuEntries } from "./diff-menu";
import { JumpPopover } from "./DiffJumpPopover";
import { OptionsMenu } from "./DiffOptionsMenu";
import { writeClipboardText } from "@/shared/clipboard";
import { useDismissLayer } from "../core/useDismissLayer";
import type { JumpFile } from "./jump-files";
import type { DiffScopeItem } from "./scope";
import { DIFF_TOOLBAR_ICON_IDS } from "./toolbar-actions";

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
    if (!copyStatus) return;
    const timer = window.setTimeout(() => setCopyStatus(""), 2500);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  useDismissLayer(menu !== null, () => setMenu(null));
  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-diff-options-menu], [data-diff-jump-popover]")) return;
      setMenu(null);
    };
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("mousedown", onPointer);
    };
  }, [menu]);

  return (
    <div
      ref={rootRef}
      data-diff-toolbar
      className="relative z-20 flex h-10 min-w-0 shrink-0 flex-nowrap items-center gap-1.5 border-b border-[#222] bg-[#0f0f0f] px-2"
    >
      {scopes.length > 0 ? <div className="relative shrink-0">
        <button
          type="button"
          data-diff-scope
          aria-expanded={menu === "scope"}
          aria-haspopup="menu"
          className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md bg-[#1c1c1c] px-2 text-[12px] text-[#e8e8e8]"
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
                data-diff-scope-item={item.id}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-xs text-zinc-100 hover:bg-zinc-800"
                onClick={() => {
                  onScope(item.id);
                  setMenu(null);
                }}
              >
                <span className="min-w-0 flex-1">{item.label}</span>
                {scope === item.id ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div> : null}
      <span className="shrink-0 whitespace-nowrap font-mono text-[12px] text-[#3fb950]">+{added}</span>
      <span className="shrink-0 whitespace-nowrap font-mono text-[12px] text-[#f85149]">-{removed}</span>
      <p
        role="status"
        data-diff-copy-status={copyStatus || undefined}
        className="min-w-0 truncate text-[12px] text-zinc-400"
      >
        {copyStatus}
      </p>
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
    </div>
  );
}

