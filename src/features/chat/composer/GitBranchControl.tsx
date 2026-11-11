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
import { useComposerMenu } from "./useComposerMenu";
import { useGitBranch } from "./useGitBranch";
import { worktreeBranchMarker } from "./worktree-option";
import { CONTEXT_PILL_BASE_CLASS, contextPillStyle } from "./context-pill";
import { WorkContextPicker } from "./WorkContextPicker";
import { WorktreeSessionLabel, WorktreeToggle } from "./WorktreeChoice";

export function ComposerContextRow({
  workContext,
  projectId,
  projectName,
  sessionId,
  worktree,
}: {
  workContext: ComponentProps<typeof WorkContextPicker> | null;
  projectId: string;
  projectName: string;
  sessionId?: string;
  worktree?: {
    showToggle: boolean;
    pressed: boolean;
    onToggle: () => void;
    liveLabel: string;
    liveTitle: string;
    base?: string | null;
    sha?: string | null;
  } | null;
}) {
  const branch = useGitBranch(projectId, {
    sessionId,
    isolated: Boolean(worktree?.liveTitle),
  });
  const worktreeLabel = worktree?.liveTitle
    ? worktreeBranchMarker({
        liveBranch: branch.current,
        base: worktree.base,
        sha: worktree.sha,
      })
    : null;
  const showBranch = worktree?.liveTitle ? Boolean(worktreeLabel) : branch.visible;
  if (!workContext && !showBranch && !worktree?.showToggle && !worktree?.liveLabel) return null;
  return (
    <div
      className="mb-2 flex min-w-0 items-center gap-2 px-1"
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
      {showBranch ? (
        <GitBranchChrome
          key={projectId}
          label={worktreeLabel ?? branch.label}
          projectName={projectName}
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
        className={cn(CONTEXT_PILL_BASE_CLASS, "max-w-[14rem] pl-2 pr-2.5")}
        style={contextPillStyle(lifted)}
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
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--wb-muted)]" strokeWidth={1.75} />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="分支"
          data-git-branch-menu=""
          className="fixed z-50 flex w-[300px] max-h-[min(24rem,calc(100vh-2rem))] flex-col overflow-hidden rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] py-1 shadow-[var(--wb-float-shadow)]"
          style={{ top: -9999, left: 8 }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-2 border-b border-[var(--wb-border)] px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-[var(--wb-faint)]" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={branchSearchPlaceholder(projectName)}
              aria-label={branchSearchPlaceholder(projectName)}
              className="w-full bg-transparent text-sm text-[var(--wb-text-strong)] outline-none placeholder:text-[var(--wb-faint)]"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <p className="px-3 pb-1 pt-2 text-xs text-[var(--wb-faint)]">分支</p>
            {actionError ? (
              <p role="alert" className="px-3 pb-1 text-xs text-[var(--wb-danger-text)]">
                {actionError}
              </p>
            ) : null}
            {listError ? (
              <p className="px-3 py-2 text-xs text-[var(--wb-danger-text)]">{listError}</p>
            ) : null}
            {loading ? <p className="px-3 py-2 text-xs text-[var(--wb-muted)]">正在读取分支…</p> : null}
            {!loading && !listError && shown.length === 0 ? (
              <p className="px-3 py-2 text-xs text-[var(--wb-muted)]">没有匹配的分支</p>
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
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--wb-text-strong)] hover:bg-[var(--wb-hover)] disabled:opacity-60"
                  onClick={(event) => {
                    event.stopPropagation();
                    void checkout(name);
                  }}
                >
                  <GitBranch className="h-4 w-4 shrink-0 text-[var(--wb-muted)]" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-sm", selected && "font-semibold")}>{name}</span>
                    {subtitle ? (
                      <span data-git-dirty-files={dirtyFiles} className="block truncate text-xs text-[var(--wb-muted)]">
                        {subtitle}
                      </span>
                    ) : null}
                  </span>
                  {selected ? <Check className="h-4 w-4 shrink-0 text-[var(--wb-text-strong)]" strokeWidth={2} /> : null}
                </button>
              );
            })}
          </div>
          <div className="border-t border-[var(--wb-border)]" />
          <button
            type="button"
            role="menuitem"
            data-git-branch-create=""
            disabled={busy}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--wb-text-strong)] hover:bg-[var(--wb-hover)] disabled:opacity-60"
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
            <label className="grid gap-1.5 text-sm text-[var(--wb-text)]" htmlFor="git-branch-name">
              分支名
              <input
                id="git-branch-name"
                autoFocus
                value={createName}
                onChange={(event) => {
                  setCreateName(event.target.value);
                  if (createError) setCreateError(null);
                }}
                className="h-9 rounded-lg border border-[var(--wb-border-strong)] bg-[var(--wb-well)] px-3 text-sm text-[var(--wb-text-strong)] outline-none focus:border-[var(--wb-accent)]"
              />
            </label>
            {createError ? (
              <p role="alert" className="text-xs text-[var(--wb-danger-text)]">
                {createError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                className="text-[var(--wb-muted)] hover:bg-transparent hover:text-[var(--wb-text-strong)]"
                disabled={busy}
                onClick={() => setCreateOpen(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-[var(--wb-send-bg)] px-4 text-[var(--wb-send-fg)] shadow-none hover:opacity-90"
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
