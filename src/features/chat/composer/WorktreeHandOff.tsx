import { useState } from "react";
import { ArrowLeftRight } from "lucide-react";

import { userFacingMessage } from "@/lib/user-facing";

import { BranchNameDialog } from "./BranchNameDialog";
import type { WorktreeHandOffLine } from "./host";

/**
 * 交给项目目录 / 交回工作树。工作树还没有分支时先起一个分支名。
 * `branchKnown` 为假时还不知道工作树在不在分支上，先不让交。
 */
export function WorktreeHandOff({
  handOff,
  hasBranch,
  branchKnown,
}: {
  handOff: WorktreeHandOffLine;
  hasBranch: boolean;
  branchKnown: boolean;
}) {
  const [naming, setNaming] = useState(false);
  const [namingError, setNamingError] = useState<string | null>(null);

  const toLocal = () => {
    if (hasBranch) {
      handOff.onHandOff();
      return;
    }
    setNamingError(null);
    setNaming(true);
  };
  // 起名对话框等交接做完再关，失败的原因（分支已存在、项目目录有改动）显示在对话框里。
  const submitName = async (name: string) => {
    setNamingError(null);
    try {
      await handOff.onHandOffAs(name);
      setNaming(false);
    } catch (error) {
      setNamingError(userFacingMessage(error) ?? "没能交给项目目录");
    }
  };

  return (
    <>
      {handOff.localBranch ? (
        <span
          data-worktree-local={handOff.localBranch}
          className="inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-wb-border bg-wb-surface/75 pl-2 pr-1 text-xs text-wb-fg-2"
        >
          <span className="truncate">在项目目录</span>
          <button
            type="button"
            data-worktree-hand-back=""
            disabled={handOff.busy}
            className="shrink-0 rounded px-1.5 py-0.5 text-wb-fg transition-colors hover:bg-wb-hover disabled:opacity-60"
            onClick={(event) => {
              event.stopPropagation();
              handOff.onHandOff();
            }}
          >
            {handOff.busy ? "正在交回…" : "交回工作树"}
          </button>
        </span>
      ) : (
        <button
          type="button"
          data-worktree-hand-off=""
          disabled={handOff.busy || !branchKnown}
          className="inline-flex h-6 items-center gap-1.5 rounded-md border border-wb-border bg-wb-surface/75 px-2 text-xs text-wb-fg-2 transition-colors hover:border-wb-border-strong hover:bg-wb-hover hover:text-wb-fg disabled:opacity-60"
          onClick={(event) => {
            event.stopPropagation();
            toLocal();
          }}
        >
          <ArrowLeftRight className="h-3 w-3 shrink-0 opacity-80" strokeWidth={1.75} />
          {handOff.busy ? "正在交给项目目录…" : "交给项目目录"}
        </button>
      )}
      <BranchNameDialog
        open={naming}
        title="交给项目目录"
        description="项目目录会切到这个分支，工作树里的改动一起带过去。"
        initialName={handOff.suggestedBranch}
        submitLabel="交给项目目录"
        busyLabel="正在交给项目目录…"
        busy={handOff.busy}
        error={namingError}
        dataAttr="data-worktree-hand-off-dialog"
        onCancel={() => setNaming(false)}
        onSubmit={(name) => void submitName(name)}
      />
    </>
  );
}
