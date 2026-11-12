import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, GitBranch, Search } from "lucide-react";

import { cn } from "@/lib/utils";

import { branchSearchPlaceholder, filterBranchNames } from "./git-branch";
import { useComposerMenu } from "./useComposerMenu";

/**
 * 作曲栏上的分支芯片和它的下拉：搜索框、分支列表、读取中和空列表的提示。
 * 切换分支、选工作树起点都用这一个，行怎么画、点了做什么由调用方给。
 */
export function BranchMenu({
  name,
  label,
  chipAttrs,
  menuAttrs,
  projectName,
  branches,
  listError,
  actionError,
  open,
  onOpenChange,
  renderRows,
  footer,
}: {
  /** 这个菜单叫什么：读屏标签和列表标题都用它。 */
  name: string;
  label: string;
  chipAttrs: Record<string, string>;
  menuAttrs: Record<string, string>;
  projectName: string;
  branches: readonly string[];
  listError: string | null;
  actionError?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  renderRows: (shown: string[]) => ReactNode;
  footer?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  useComposerMenu(open, anchorRef, menuRef, close, `${query}:${branches.length}:${listError ?? ""}`);
  const shown = filterBranchNames(branches, query);
  const loading = open && branches.length === 0 && !listError;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={cn(
          "inline-flex h-6 max-w-[16rem] items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
          open
            ? "border-wb-border-strong bg-wb-active text-wb-fg"
            : "border-wb-border bg-wb-surface/75 text-wb-fg-2 hover:border-wb-border-strong hover:bg-wb-hover hover:text-wb-fg",
        )}
        aria-label={`${name}：${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        {...chipAttrs}
        onClick={(event) => {
          event.stopPropagation();
          onOpenChange(!open);
        }}
      >
        <GitBranch className="h-3 w-3 shrink-0 opacity-80" strokeWidth={1.75} />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={name}
          {...menuAttrs}
          className="wb-popover fixed z-50 flex max-h-[min(24rem,calc(100vh-2rem))] w-[300px] flex-col overflow-hidden rounded-xl p-1"
          style={{ top: -9999, left: 8 }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-2 border-b border-wb-border px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-wb-dim" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={branchSearchPlaceholder(projectName)}
              aria-label={branchSearchPlaceholder(projectName)}
              className="w-full bg-transparent text-sm text-wb-fg outline-none placeholder:text-wb-dim"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pt-1">
            <p className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-wb-fg-3">{name}</p>
            {actionError ? (
              <p role="alert" className="px-2.5 pb-1 text-xs text-wb-danger">
                {actionError}
              </p>
            ) : null}
            {listError ? <p className="px-2.5 py-2 text-xs text-wb-danger">{listError}</p> : null}
            {loading ? <p className="px-2.5 py-2 text-xs text-wb-fg-3">正在读取分支…</p> : null}
            {!loading && !listError && shown.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-wb-fg-3">没有匹配的分支</p>
            ) : null}
            {renderRows(shown)}
          </div>
          {footer ? (
            <>
              <div className="my-1 border-t border-wb-border" />
              {footer}
            </>
          ) : null}
        </div>
      )}
    </>
  );
}

/** 下拉里的一行分支。 */
export function BranchRow({
  name,
  subtitle,
  selected,
  disabled,
  attrs,
  onPick,
}: {
  name: string;
  subtitle: ReactNode;
  selected: boolean;
  disabled?: boolean;
  attrs: Record<string, string | number | undefined>;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      {...attrs}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-wb-fg transition-colors hover:bg-wb-hover disabled:opacity-60",
        selected && "bg-wb-active/70",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onPick();
      }}
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0 text-wb-fg-3" strokeWidth={1.75} />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm", selected && "font-medium")}>{name}</span>
        {subtitle}
      </span>
      {selected ? <Check className="h-3.5 w-3.5 shrink-0 text-wb-accent" strokeWidth={2} /> : null}
    </button>
  );
}
