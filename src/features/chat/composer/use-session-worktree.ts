import { useEffect, useState } from "react";

import { sessionSupportsWorktree } from "@/lib/catalog";
import { backend } from "@/lib/ipc";
import { useWorkbench } from "@/store";
import { isDraftId } from "@/store/draft-session";
import { isStandaloneDraft } from "@/store/standalone";
import type { Session } from "@/types";

import { showWorktreeOption, worktreeCaption } from "./worktree-option";

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
