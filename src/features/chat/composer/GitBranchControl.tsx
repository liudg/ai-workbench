import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { Check, GitBranch, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { userFacingMessage } from "@/lib/user-facing";
import { cn } from "@/lib/utils";

import {
  branchNameError,
  branchSearchPlaceholder,
  filterBranchNames,
  uncommittedFileLabel,
} from "./git-branch";
import type { ComposerHost, WorktreeLine } from "./host";
import { useComposerMenu } from "./useComposerMenu";
import { CARD_BG, CARD_BG_HOT, CARD_SHADOW } from "./context-card";
import { useGitBranch } from "./useGitBranch";
import { worktreeBranchMarker } from "./worktree-option";
import { WorkContextPicker } from "./WorkContextPicker";
import { WorktreeSessionLabel, WorktreeToggle } from "./WorktreeChoice";

export function ComposerContextRow({
  workContext,
  git,
  worktree,
}: {
  workContext: ComponentProps<typeof WorkContextPicker> | null;
  git: ComposerHost["git"];
  worktree: WorktreeLine | null;
}) {
  const branch = useGitBranch(git?.projectId ?? "", {
    sessionId: git?.sessionId,
    isolated: Boolean(worktree?.liveTitle),
  });
  const worktreeLabel = worktree?.liveTitle
    ? worktreeBranchMarker({
        liveBranch: branch.current,
        base: worktree.base,
        sha: worktree.sha,
      })
    : null;
  const showBranch = Boolean(git) && (worktree?.liveTitle ? Boolean(worktreeLabel) : branch.visible);
  if (!workContext && !showBranch && !worktree?.showToggle && !worktree?.liveLabel) return null;
  return (
    <div
      className="mb-2 flex min-w-0 flex-wrap items-center gap-2 px-1"
      data-composer-context
      data-work-context-slot="above-input"
    >
      {workContext ? <WorkContextPicker {...workContext} /> : null}
      {worktree?.showToggle ? (
        <WorktreeToggle pressed={worktree.pressed} onToggle={worktree.onToggle} />
      ) : null}
      {worktree?.liveLabel ? (
        <WorktreeSessionLabel label={worktree.liveLabel} title={worktree.liveTitle} />
      ) : null}
      {showBranch && git ? (
        <GitBranchChrome
          key={git.projectId}
          label={worktreeLabel ?? branch.label}
          projectName={git.projectName}
          current={branch.current}
          branches={branch.branches}
          dirtyFiles={branch.dirtyFiles}
          listError={branch.listError}
          onMenuActive={branch.setMenuActive}
          onCheckout={branch.checkout}
          onCreate={branch.create}
        />
      ) : null}
    </div>
  );
}

export function GitBranchChrome({
  label,
  projectName,
  current,
  branches,
  dirtyFiles,
  listError,
  initialOpen = false,
  initialCreate = false,
  onMenuActive,
  onCheckout,
  onCreate,
}: {
  label: string;
  projectName: string;
  current: string | null;
  branches: readonly string[];
  dirtyFiles: number | null;
  listError: string | null;
  initialOpen?: boolean;
  initialCreate?: boolean;
  onMenuActive?: (open: boolean) => void;
  onCheckout: (name: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [hot, setHot] = useState(false);
  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(initialCreate);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setActionError(null);
  }, []);
  useEffect(() => {
    onMenuActive?.(open);
  }, [open, onMenuActive]);
  useComposerMenu(open, anchorRef, menuRef, close, `${query}:${branches.length}:${listError ?? ""}`);
  const lifted = open || hot;
  const shown = filterBranchNames(branches, query);
  const loading = open && branches.length === 0 && !listError;

  const toggle = () => {
    setActionError(null);
    setQuery("");
    setOpen((value) => !value);
  };

  const checkout = async (name: string) => {
    if (busy) return;
    if (name === current) {
      close();
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await onCheckout(name);
      close();
    } catch (error) {
      setActionError(userFacingMessage(error) ?? "无法切换分支");
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = async () => {
    const failure = branchNameError(createName);
    if (failure) {
      setCreateError(failure);
      return;
    }
    setBusy(true);
    setCreateError(null);
    try {
      await onCreate(createName);
      setCreateOpen(false);
      setCreateName("");
      close();
    } catch (error) {
      setCreateError(userFacingMessage(error) ?? "无法创建分支");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-[10px] border py-1 pl-2 pr-2.5 text-[13px] leading-5 text-[#ececef]"
        style={{
          backgroundImage: lifted ? CARD_BG_HOT : CARD_BG,
          borderColor: lifted ? "#3a3a42" : "#2e2e33",
          boxShadow: CARD_SHADOW,
        }}
        aria-label={`分支：${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-git-branch={label}
        onMouseEnter={() => setHot(true)}
        onMouseLeave={() => setHot(false)}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
      >
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#d2d2d6]" strokeWidth={1.75} />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="分支"
          data-git-branch-menu=""
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
            <p className="px-3 pb-1 pt-2 text-xs text-zinc-500">分支</p>
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
            {shown.map((name) => {
              const selected = name === current;
              const subtitle = selected ? uncommittedFileLabel(dirtyFiles) : null;
              return (
                <button
                  key={name}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  data-git-branch-name={name}
                  disabled={busy}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-zinc-100 hover:bg-white/[0.06] disabled:opacity-60"
                  onClick={(event) => {
                    event.stopPropagation();
                    void checkout(name);
                  }}
                >
                  <GitBranch className="h-4 w-4 shrink-0 text-zinc-400" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-sm", selected && "font-semibold")}>{name}</span>
                    {subtitle ? (
                      <span data-git-dirty-files={dirtyFiles} className="block truncate text-xs text-zinc-500">
                        {subtitle}
                      </span>
                    ) : null}
                  </span>
                  {selected ? <Check className="h-4 w-4 shrink-0 text-zinc-200" strokeWidth={2} /> : null}
                </button>
              );
            })}
          </div>
          <div className="border-t border-zinc-800" />
          <button
            type="button"
            role="menuitem"
            data-git-branch-create=""
            disabled={busy}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-100 hover:bg-white/[0.06] disabled:opacity-60"
            onClick={(event) => {
              event.stopPropagation();
              setCreateName("");
              setCreateError(null);
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4 shrink-0" />
            创建并检出新分支…
          </button>
        </div>
      )}
      <Dialog
        open={createOpen}
        onOpenChange={(next) => {
          if (busy) return;
          setCreateOpen(next);
          if (!next) setCreateError(null);
        }}
      >
        <DialogContent data-git-branch-dialog="">
          <DialogHeader>
            <DialogTitle>创建并检出新分支</DialogTitle>
            <DialogDescription className="sr-only">输入分支名</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
          >
            <label className="grid gap-1.5 text-sm text-zinc-300" htmlFor="git-branch-name">
              分支名
              <input
                id="git-branch-name"
                autoFocus
                value={createName}
                onChange={(event) => {
                  setCreateName(event.target.value);
                  if (createError) setCreateError(null);
                }}
                className="h-9 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              />
            </label>
            {createError ? (
              <p role="alert" className="text-xs text-red-300">
                {createError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                className="text-zinc-400 hover:bg-transparent hover:text-zinc-200"
                disabled={busy}
                onClick={() => setCreateOpen(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-zinc-100 px-4 text-zinc-950 shadow-none hover:bg-white"
              >
                {busy ? "正在创建…" : "创建"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
