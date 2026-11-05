import { useState } from "react";
import { ArrowLeftRight } from "lucide-react";

import { userFacingMessage } from "@/lib/user-facing";

import { BranchNameDialog } from "./BranchNameDialog";
import type { WorktreeHandOffLine } from "./host";
import { CARD_BG, CARD_SHADOW } from "./context-card";

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
          className="inline-flex max-w-full min-w-0 items-center gap-2 rounded-[10px] border border-[#2e2e33] py-1 pl-2.5 pr-1 text-[13px] leading-5 text-[#ececef]"
          style={{ backgroundImage: CARD_BG, boxShadow: CARD_SHADOW }}
        >
          <span className="truncate">在项目目录</span>
          <button
            type="button"
            data-worktree-hand-back=""
            disabled={handOff.busy}
            className="shrink-0 rounded-md px-2 hover:bg-white/[0.08] disabled:opacity-60"
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
          className="inline-flex items-center gap-1.5 rounded-[10px] border border-[#2e2e33] py-1 pl-2 pr-2.5 text-[13px] leading-5 text-[#ececef] disabled:opacity-60"
          style={{ backgroundImage: CARD_BG, boxShadow: CARD_SHADOW }}
          onClick={(event) => {
            event.stopPropagation();
            toLocal();
          }}
        >
          <ArrowLeftRight className="h-3.5 w-3.5 shrink-0 text-[#d2d2d6]" strokeWidth={1.75} />
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
