import { useEffect, useState } from "react";

import { projectsApi } from "@/features/projects";
import {
  cachedProjectBranch,
  projectBranchStamp,
  rememberProjectBranch,
  subscribeProjectBranch,
} from "@/shared/project-branch";

/** 当前 git 分支。不是仓库、分离头指针或探测失败时不显示。 */
export function useProjectBranch(projectId: string): string | null {
  const [branch, setBranch] = useState<string | null>(() =>
    projectId ? (cachedProjectBranch(projectId) ?? null) : null,
  );

  useEffect(() => {
    if (!projectId) return;
    return subscribeProjectBranch((id) => {
      if (id === projectId) setBranch(cachedProjectBranch(projectId) ?? null);
    });
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setBranch(null);
      return;
    }
    const cached = cachedProjectBranch(projectId);
    if (cached !== undefined) setBranch(cached);
    const seen = projectBranchStamp(projectId);
    let cancel = false;
    void projectsApi.currentBranch({ projectId }).then(
      (value) => {
        if (cancel || projectBranchStamp(projectId) !== seen) return;
        rememberProjectBranch(projectId, value);
        if (!cancel) setBranch(cachedProjectBranch(projectId) ?? null);
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
