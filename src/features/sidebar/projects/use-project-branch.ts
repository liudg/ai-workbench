import { useEffect, useState } from "react";

import { backend } from "@/lib/ipc";

const cache = new Map<string, string | null>();

function branchName(value: string | null | undefined): string | null {
  const name = value?.trim() ?? "";
  if (!name || name === "HEAD") return null;
  return name;
}

/** 当前 git 分支。不是仓库、分离头指针或探测失败时不显示。 */
export function useProjectBranch(projectId: string): string | null {
  const [branch, setBranch] = useState<string | null>(() => (projectId ? (cache.get(projectId) ?? null) : null));

  useEffect(() => {
    if (!projectId) {
      setBranch(null);
      return;
    }
    const cached = cache.get(projectId);
    if (cached !== undefined) setBranch(cached);
    let cancel = false;
    void backend.projectBranch(projectId).then(
      (value) => {
        const next = branchName(value);
        cache.set(projectId, next);
        if (!cancel) setBranch(next);
      },
      () => {
        if (!cancel && cached === undefined) setBranch(null);
      },
    );
    return () => {
      cancel = true;
    };
  }, [projectId]);

  return branch;
}
