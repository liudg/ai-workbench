import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { Plus } from "lucide-react";

import { userFacingMessage } from "@/lib/user-facing";

import { BranchMenu, BranchRow } from "./BranchMenu";
import { BranchNameDialog } from "./BranchNameDialog";
import { uncommittedFileLabel } from "./git-branch";
import type { ComposerHost, WorktreeLine } from "./host";
import { useGitBranch } from "./useGitBranch";
import { WORKTREE_BRANCH_PREFIX, worktreeBranchMarker } from "./worktree-option";
import { WorkContextPicker } from "./WorkContextPicker";
import { WorktreeHandOff } from "./WorktreeHandOff";
import { WorktreeStartPicker } from "./WorktreeStartPicker";
import { WorktreeSessionLabel, WorktreeShelvedLabel, WorktreeToggle } from "./WorktreeChoice";

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
  const shelved = worktree?.shelved ?? null;
  // 新任务开了工作树时选起点，不切换项目目录的分支。
  const start = worktree?.pressed && worktree.start && branch.visible ? worktree.start : null;
  const showBranch =
    Boolean(git) && !shelved && !start && (worktree?.liveTitle ? Boolean(worktreeLabel) : branch.visible);
  const handOff = !shelved ? (worktree?.handOff ?? null) : null;
  if (!workContext && !showBranch && !start && !handOff && !worktree?.showToggle && !worktree?.liveLabel) return null;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-wb-border px-2.5 py-1.5"
      data-composer-context
      data-work-context-slot="above-input"
      onClick={(event) => event.stopPropagation()}
    >
      {workContext ? <WorkContextPicker {...workContext} /> : null}
      {worktree?.showToggle ? (
        <WorktreeToggle pressed={worktree.pressed} onToggle={worktree.onToggle} />
      ) : null}
      {shelved && worktree ? (
        <WorktreeShelvedLabel title={worktree.liveTitle} restoring={shelved.restoring} onRestore={shelved.onRestore} />
      ) : worktree?.liveLabel ? (
        <WorktreeSessionLabel label={worktree.liveLabel} title={worktree.liveTitle} />
      ) : null}
      {handOff ? <WorktreeHandOff handOff={handOff} hasBranch={Boolean(branch.current)} branchKnown={branch.visible} /> : null}
      {start && git ? (
        <WorktreeStartPicker
          start={start}
          projectName={git.projectName}
          current={branch.current}
          branches={branch.branches}
          dirtyFiles={branch.dirtyFiles}
          listError={branch.listError}
          onMenuActive={branch.setMenuActive}
        />
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
          createPrefix={worktree?.liveTitle && !branch.current ? WORKTREE_BRANCH_PREFIX : ""}
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
  createPrefix = "",
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
  /** 新分支名预填的前缀。 */
  createPrefix?: string;
  onMenuActive?: (open: boolean) => void;
  onCheckout: (name: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(initialCreate);
  const [createError, setCreateError] = useState<string | null>(null);
  const setMenuOpen = useCallback((next: boolean) => {
    setOpen(next);
    setActionError(null);
  }, []);
  useEffect(() => {
    onMenuActive?.(open);
  }, [open, onMenuActive]);

  const checkout = async (name: string) => {
    if (busy) return;
    if (name === current) {
      setMenuOpen(false);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await onCheckout(name);
      setMenuOpen(false);
    } catch (error) {
      setActionError(userFacingMessage(error) ?? "无法切换分支");
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = async (name: string) => {
    setBusy(true);
    setCreateError(null);
    try {
      await onCreate(name);
      setCreateOpen(false);
      setMenuOpen(false);
    } catch (error) {
      setCreateError(userFacingMessage(error) ?? "无法创建分支");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <BranchMenu
        name="分支"
        label={label}
        chipAttrs={{ "data-git-branch": label }}
        menuAttrs={{ "data-git-branch-menu": "" }}
        projectName={projectName}
        branches={branches}
        listError={listError}
        actionError={actionError}
        open={open}
        onOpenChange={setMenuOpen}
        renderRows={(shown) =>
          shown.map((name) => {
            const selected = name === current;
            const subtitle = selected ? uncommittedFileLabel(dirtyFiles) : null;
            return (
              <BranchRow
                key={name}
                name={name}
                selected={selected}
                disabled={busy}
                attrs={{ "data-git-branch-name": name }}
                subtitle={
                  subtitle ? (
                    <span data-git-dirty-files={dirtyFiles ?? undefined} className="block truncate text-xs text-wb-fg-3">
                      {subtitle}
                    </span>
                  ) : null
                }
                onPick={() => void checkout(name)}
              />
            );
          })
        }
        footer={
          <button
            type="button"
            role="menuitem"
            data-git-branch-create=""
            disabled={busy}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-wb-fg transition-colors hover:bg-wb-hover disabled:opacity-60"
            onClick={(event) => {
              event.stopPropagation();
              setCreateError(null);
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4 shrink-0" />
            创建并检出新分支…
          </button>
        }
      />
      <BranchNameDialog
        open={createOpen}
        title="创建并检出新分支"
        initialName={createPrefix}
        submitLabel="创建"
        busyLabel="正在创建…"
        busy={busy}
        error={createError}
        dataAttr="data-git-branch-dialog"
        onCancel={() => {
          setCreateOpen(false);
          setCreateError(null);
        }}
        onSubmit={(name) => void submitCreate(name)}
      />
    </>
  );
}
