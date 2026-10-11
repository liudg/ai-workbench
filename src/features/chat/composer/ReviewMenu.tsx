import { useEffect, useState } from "react";

import { backend } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { ReviewStart, ReviewTargets } from "@/types";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";

export function ReviewMenu({
  sessionId,
  onStart,
}: {
  sessionId: string;
  onStart: (target: ReviewStart) => void;
}) {
  const [targets, setTargets] = useState<ReviewTargets | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const load = () => {
    setLoading(true);
    void backend
      .reviewTargets(sessionId)
      .then((next) => setTargets(next))
      .catch(() => {
        setTargets({
          branches: [],
          commits: [],
          error: DESKTOP_ZH.reviewBranchesError,
        });
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // 打开菜单时拉一次分支和提交，和桌面端保持打开加载一致。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const typed = query.trim();
  const branches = targets?.branches ?? [];
  const visible = branches.filter((branch) =>
    branch.toLowerCase().includes(typed.toLowerCase()),
  );
  const exact = branches.some((branch) => branch === typed);
  const showUse = typed.length > 0 && !exact;
  const failed = !loading && Boolean(targets?.error);

  const startBranch = (branch: string) => onStart({ kind: "base", branch });

  return (
    <div
      role="menu"
      aria-label={DESKTOP_ZH.reviewTitle}
      className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-80 min-w-0 overflow-x-hidden overflow-y-auto rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
    >
      <button
        type="button"
        role="menuitem"
        className="flex w-full min-w-0 px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
        onMouseDown={(event) => {
          event.preventDefault();
          onStart({ kind: "uncommitted" });
        }}
      >
        {DESKTOP_ZH.reviewUncommitted}
      </button>
      <p className="px-3 pb-1 pt-2 text-[11px] text-zinc-500">{DESKTOP_ZH.reviewBase}</p>
      <div className="px-3 pb-1">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={DESKTOP_ZH.reviewSearchBranches}
          aria-label={DESKTOP_ZH.reviewSearchBranches}
          className="h-8 w-full min-w-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
      </div>
      {showUse && (
        <button
          type="button"
          role="menuitem"
          className="flex w-full min-w-0 px-3 py-1.5 text-left text-sm text-zinc-100 hover:bg-zinc-800"
          onMouseDown={(event) => {
            event.preventDefault();
            startBranch(typed);
          }}
        >
          <span className="min-w-0 break-all">
            {DESKTOP_ZH.reviewUseBranch.replace("{branch}", typed)}
          </span>
        </button>
      )}
      {loading && (
        <p className="px-3 py-1.5 text-xs text-zinc-500">{DESKTOP_ZH.reviewLoadingBranches}</p>
      )}
      {failed && (
        <div className="flex flex-col gap-1 px-3 py-1.5">
          <p className="text-xs text-zinc-400">{DESKTOP_ZH.reviewBranchesError}</p>
          <button
            type="button"
            className="w-fit text-xs font-medium text-sky-400 hover:text-sky-300"
            onMouseDown={(event) => {
              event.preventDefault();
              load();
            }}
          >
            {DESKTOP_ZH.reviewRetry}
          </button>
        </div>
      )}
      {!loading && !failed && visible.length === 0 && !showUse && (
        <p className="px-3 py-1.5 text-xs text-zinc-500">{DESKTOP_ZH.reviewNoBranches}</p>
      )}
      {!loading &&
        !failed &&
        visible.map((branch) => (
          <button
            key={branch}
            type="button"
            role="menuitem"
            className="flex w-full min-w-0 px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-800"
            onMouseDown={(event) => {
              event.preventDefault();
              startBranch(branch);
            }}
          >
            <span className="min-w-0 break-all">{branch}</span>
          </button>
        ))}
      <p className="px-3 pb-1 pt-2 text-[11px] text-zinc-500">{DESKTOP_ZH.reviewCommit}</p>
      {!loading &&
        targets?.commits.map((commit) => (
          <button
            key={commit.sha}
            type="button"
            role="menuitem"
            className={cn(
              "flex w-full min-w-0 items-baseline gap-2 px-3 py-1.5 text-left hover:bg-zinc-800",
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              onStart({ kind: "commit", sha: commit.sha, title: commit.title });
            }}
          >
            <span className="shrink-0 font-mono text-xs text-zinc-400">
              {commit.sha.slice(0, 7)}
            </span>
            <span className="min-w-0 break-words text-sm text-zinc-200">{commit.title}</span>
          </button>
        ))}
    </div>
  );
}
