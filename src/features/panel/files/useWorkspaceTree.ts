import { useEffect, useState } from "react";

import { backend } from "@/lib/ipc";

/** 工作区目录树。点文件由打开文件页去预览。 */
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
