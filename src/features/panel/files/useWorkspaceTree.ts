import { useEffect, useState } from "react";

import { backend } from "@/lib/ipc";

/** 工作区目录树。打开文件页只用路径，不打开预览。 */
export function useWorkspaceTree(projectId: string): string[] {
  const [paths, setPaths] = useState<string[]>([]);
  useEffect(() => {
    let cancel = false;
    void backend.listProjectTree(projectId).then(
      (tree) => {
        if (!cancel) setPaths(tree.paths);
      },
      () => {
        if (!cancel) setPaths([]);
      },
    );
    return () => {
      cancel = true;
    };
  }, [projectId]);
  return paths;
}
