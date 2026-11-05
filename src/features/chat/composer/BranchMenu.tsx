import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, GitBranch, Search } from "lucide-react";

import { cn } from "@/lib/utils";

import { CARD_BG, CARD_BG_HOT, CARD_SHADOW } from "./context-card";
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
  const [hot, setHot] = useState(false);
  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  useComposerMenu(open, anchorRef, menuRef, close, `${query}:${branches.length}:${listError ?? ""}`);
  const lifted = open || hot;
  const shown = filterBranchNames(branches, query);
  const loading = open && branches.length === 0 && !listError;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-[10px] border py-1 pl-2 pr-2.5 text-[13px] leading-5 text-[#ececef]"
        style={{
          backgroundImage: lifted ? CARD_BG_HOT : CARD_BG,
          borderColor: lifted ? "#3a3a42" : "#2e2e33",
          boxShadow: CARD_SHADOW,
        }}
        aria-label={`${name}：${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        {...chipAttrs}
        onMouseEnter={() => setHot(true)}
        onMouseLeave={() => setHot(false)}
        onClick={(event) => {
          event.stopPropagation();
          onOpenChange(!open);
        }}
      >
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#d2d2d6]" strokeWidth={1.75} />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={name}
          {...menuAttrs}
          className="fixed z-50 flex w-[300px] max-h-[min(24rem,calc(100vh-2rem))] flex-col overflow-hidden rounded-[10px] border border-[#2e2e33] py-1"
          style={{ top: -9999, left: 8, backgroundImage: CARD_BG, boxShadow: CARD_SHADOW }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-zinc-500" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={branchSearchPlaceholder(projectName)}
              aria-label={branchSearchPlaceholder(projectName)}
              className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <p className="px-3 pb-1 pt-2 text-xs text-zinc-500">{name}</p>
            {actionError ? (
              <p role="alert" className="px-3 pb-1 text-xs text-red-300">
                {actionError}
              </p>
            ) : null}
            {listError ? <p className="px-3 py-2 text-xs text-red-300">{listError}</p> : null}
            {loading ? <p className="px-3 py-2 text-xs text-zinc-500">正在读取分支…</p> : null}
            {!loading && !listError && shown.length === 0 ? (
              <p className="px-3 py-2 text-xs text-zinc-500">没有匹配的分支</p>
            ) : null}
            {renderRows(shown)}
          </div>
          {footer ? (
            <>
              <div className="border-t border-zinc-800" />
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
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-zinc-100 hover:bg-white/[0.06] disabled:opacity-60"
      onClick={(event) => {
        event.stopPropagation();
        onPick();
      }}
    >
      <GitBranch className="h-4 w-4 shrink-0 text-zinc-400" strokeWidth={1.75} />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm", selected && "font-semibold")}>{name}</span>
        {subtitle}
      </span>
      {selected ? <Check className="h-4 w-4 shrink-0 text-zinc-200" strokeWidth={2} /> : null}
    </button>
  );
}
