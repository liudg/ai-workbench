import { useEffect, useState } from "react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { usePanel } from "../core/PanelProvider";
import type { GitProbe } from "./git-apply";

/** 问后端这条会话的工作目录是不是 git 工作区。失败时保留后端原文，不当成「是仓库」。 */
export function useGitWorkTree(projectId: string, reloadToken: number): { status: GitProbe; reason: string } {
  const { data, sessionId } = usePanel();
  const [status, setStatus] = useState<GitProbe>("checking");
  const [reason, setReason] = useState<string>(DESKTOP_ZH.diffGitChecking);

  useEffect(() => {
    if (!projectId) {
      setStatus("no");
      setReason("项目不存在");
      return;
    }
    let cancel = false;
    setStatus("checking");
    setReason(DESKTOP_ZH.diffGitChecking);
    void data.isGit(projectId, sessionId).then(
      (yes) => {
        if (cancel) return;
        if (yes) {
          setStatus("yes");
          setReason("");
          return;
        }
        setStatus("no");
        setReason(DESKTOP_ZH.diffNotGit);
      },
      (error: unknown) => {
        if (cancel) return;
        setStatus("no");
        setReason(errorText(error));
      },
    );
    return () => {
      cancel = true;
    };
  }, [data, projectId, reloadToken, sessionId]);

  return { status, reason };
}

function errorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return DESKTOP_ZH.diffGitChecking;
}
