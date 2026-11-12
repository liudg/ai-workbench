import { useEffect, useState } from "react";

import { BranchMenu, BranchRow } from "./BranchMenu";
import type { WorktreeStart } from "./host";

/** 新工作树的起点：选一个分支，当前分支还可以带上没提交的改动。不切换项目目录的分支。 */
export function WorktreeStartPicker({
  start,
  projectName,
  current,
  branches,
  dirtyFiles,
  listError,
  onMenuActive,
}: {
  start: WorktreeStart;
  projectName: string;
  current: string | null;
  branches: readonly string[];
  dirtyFiles: number | null;
  listError: string | null;
  onMenuActive: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    onMenuActive(open);
  }, [open, onMenuActive]);

  const base = start.base ?? current;
  const carrying = start.carry && (start.base === null || start.base === current);
  const label = base ? `从 ${base}${carrying ? " 带改动" : ""}` : "从当前提交";
  const dirty = dirtyFiles ?? 0;

  const row = (name: string, carry: boolean, subtitle: string | null) => (
    <BranchRow
      key={`${name}:${carry}`}
      name={name}
      selected={name === base && carry === carrying}
      attrs={{ "data-worktree-start": name, "data-worktree-carry": carry ? "true" : undefined }}
      subtitle={subtitle ? <span className="block truncate text-xs text-wb-fg-3">{subtitle}</span> : null}
      onPick={() => {
        // 记具体的分支名：草稿留到以后发时，项目目录可能已经换了分支。
        start.onPick(name, carry);
        setOpen(false);
      }}
    />
  );

  return (
    <BranchMenu
      name="工作树起点"
      label={label}
      chipAttrs={{ "data-worktree-start-chip": "" }}
      menuAttrs={{ "data-worktree-start-menu": "" }}
      projectName={projectName}
      branches={branches}
      listError={listError}
      open={open}
      onOpenChange={setOpen}
      renderRows={(shown) =>
        shown.flatMap((name) =>
          name === current && dirty
            ? [row(name, false, "不带未提交的改动"), row(name, true, `带上未提交的改动（${dirty} 个文件）`)]
            : [row(name, false, null)],
        )
      }
    />
  );
}
