import { useEffect, useState } from "react";

import { sessionSupportsWorktree } from "@/lib/catalog";
import { backend } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store";
import { isDraftId } from "@/store/draft-session";
import { isStandaloneDraft } from "@/store/standalone";
import type { Session } from "@/types";

import { showWorktreeOption, worktreeCaption } from "./worktree-option";

const CARD_SHADOW = "0 1px 2px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.04)";
const CARD_BG = "linear-gradient(180deg, #1c1c1f 0%, #17171a 100%)";
const CARD_BG_HOT = "linear-gradient(180deg, #242428 0%, #1e1e22 100%)";

export function WorktreeToggle({
  pressed,
  onToggle,
}: {
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-worktree-toggle=""
      aria-pressed={pressed}
      className="inline-flex max-w-full items-center gap-1.5 rounded-[10px] border py-1 pl-2 pr-2.5 text-[13px] leading-5 text-[#ececef]"
      style={{
        backgroundImage: pressed ? CARD_BG_HOT : CARD_BG,
        borderColor: pressed ? "#3a3a42" : "#2e2e33",
        boxShadow: CARD_SHADOW,
      }}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <span
        aria-hidden
        className={cn("h-2 w-2 shrink-0 rounded-full", pressed ? "bg-[#ececef]" : "bg-[#5c5c66]")}
      />
      在新的工作树中运行
    </button>
  );
}

export function WorktreeSessionLabel({ label, title }: { label: string; title: string }) {
  return (
    <span
      data-worktree-session=""
      title={title}
      className="inline-flex max-w-[18rem] min-w-0 items-center truncate rounded-[10px] border border-[#2e2e33] px-2.5 py-1 text-[13px] leading-5 text-[#ececef]"
      style={{ backgroundImage: CARD_BG, boxShadow: CARD_SHADOW }}
    >
      {label}
    </span>
  );
}

/** 草稿读能力开关和仓库提交；已经跑起来的会话只展示自己的工作树路径。 */
export function useSessionWorktree(session: Session) {
  const project = useWorkbench((s) => s.projects.find((item) => item.id === session.project_id) ?? null);
  const profileCaps = useWorkbench((s) => s.profiles[session.agent]?.capabilities);
  const catalogCaps = useWorkbench((s) => s.catalogs[session.id]?.capabilities);
  const pressed = useWorkbench((s) => Boolean(s.drafts[session.project_id]?.worktree));
  const setDraftWorktree = useWorkbench((s) => s.setDraftWorktree);
  const supports = sessionSupportsWorktree(catalogCaps, profileCaps);
  const draft = isDraftId(session.id);
  const standalone = isStandaloneDraft(session.project_id) || Boolean(project?.standalone);
  const projectId = project?.id ?? "";
  const [hasCommit, setHasCommit] = useState(false);

  useEffect(() => {
    if (!draft || standalone || !supports || !projectId) {
      setHasCommit(false);
      return;
    }
    let cancel = false;
    void backend.projectHasCommit(projectId).then(
      (value) => {
        if (!cancel) setHasCommit(value);
      },
      () => {
        if (!cancel) setHasCommit(false);
      },
    );
    return () => {
      cancel = true;
    };
  }, [draft, projectId, standalone, supports]);

  const workdir = session.workdir?.trim() ?? "";
  return {
    showToggle: showWorktreeOption({
      draft,
      standalone,
      supportsWorktree: supports,
      hasCommit,
    }),
    pressed,
    onToggle: () => setDraftWorktree(session.id, !pressed),
    liveLabel: !draft && workdir ? worktreeCaption(workdir) : "",
    liveTitle: workdir,
    base: session.worktree_base ?? null,
    sha: session.worktree_sha ?? null,
  };
}
