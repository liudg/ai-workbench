import { useCallback, useEffect, useRef, useState } from "react";

import { backend } from "@/lib/ipc";
import type { GitBranchMenu } from "@/lib/ipc/dto";
import { userFacingMessage } from "@/lib/user-facing";
import { projectBranchStamp, rememberProjectBranch } from "@/shared/project-branch";

import { gitBranchChipLabel } from "./git-branch";

const POLL_MS = 2000;

function normalizeBranch(value: string | null | undefined): string | null {
  const name = value?.trim() ?? "";
  if (!name || name === "HEAD") return null;
  return name;
}

/**
 * 当前检出是不是 git 仓库、在哪条分支。
 * `sessionId` 指向工作树时，读写都落在那棵检出上。
 * 工作树自己的分支不写回项目芯片。
 */
export function useGitBranch(
  projectId: string,
  scope?: { sessionId?: string; isolated?: boolean },
) {
  const sessionId = scope?.sessionId;
  const isolated = Boolean(scope?.isolated);
  const [ready, setReady] = useState(false);
  const [isGit, setIsGit] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [menu, setMenu] = useState<GitBranchMenu | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [menuActive, setMenuActive] = useState(false);
  const readyRef = useRef(false);

  useEffect(() => {
    readyRef.current = false;
    setReady(false);
    setIsGit(false);
    setBranch(null);
    setMenu(null);
    setListError(null);
    setMenuActive(false);
    if (!projectId) return;
    let cancel = false;

    const stillCurrent = (seen: number) => {
      if (cancel) return false;
      return isolated || projectBranchStamp(projectId) === seen;
    };
    const remember = (value: string | null) => {
      if (!isolated) rememberProjectBranch(projectId, value);
    };

    const refresh = async () => {
      const seen = projectBranchStamp(projectId);
      try {
        const git = await backend.projectIsGit(projectId);
        if (!stillCurrent(seen)) return;
        if (!git) {
          readyRef.current = true;
          setReady(true);
          setIsGit(false);
          setBranch(null);
          remember(null);
          return;
        }
        const value = await backend.projectBranch(projectId, sessionId);
        if (!stillCurrent(seen)) return;
        const next = normalizeBranch(value);
        readyRef.current = true;
        setReady(true);
        setIsGit(true);
        setBranch(next);
        remember(next);
      } catch {
        if (cancel || readyRef.current) return;
        readyRef.current = true;
        setReady(true);
        setIsGit(false);
        setBranch(null);
      }
    };

    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void refresh();
    };
    void refresh();
    const timer = window.setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancel = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isolated, projectId, sessionId]);

  const projectRef = useRef(projectId);
  projectRef.current = projectId;

  const loadMenu = useCallback(async () => {
    if (!projectId) return;
    const id = projectId;
    const seen = projectBranchStamp(id);
    try {
      const snapshot = await backend.projectGitBranches(id, sessionId);
      if (projectRef.current !== id || (!isolated && projectBranchStamp(id) !== seen)) return;
      setMenu(snapshot);
      setListError(null);
      const next = normalizeBranch(snapshot.current);
      setBranch(next);
      setIsGit(true);
      setReady(true);
      readyRef.current = true;
      if (!isolated) rememberProjectBranch(id, next);
    } catch (error) {
      if (projectRef.current !== id) return;
      setListError(userFacingMessage(error) ?? "无法读取分支");
    }
  }, [isolated, projectId, sessionId]);

  useEffect(() => {
    if (!menuActive || !projectId) return;
    let cancel = false;
    const load = () => {
      void loadMenu().then(() => {
        if (cancel) return;
      });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [menuActive, projectId, loadMenu]);

  const checkout = useCallback(
    async (name: string) => {
      await backend.projectCheckoutBranch(projectId, name, sessionId);
      const next = normalizeBranch(name);
      setBranch(next);
      if (!isolated) rememberProjectBranch(projectId, next);
      setMenu((current) => (current ? { ...current, current: next } : current));
    },
    [isolated, projectId, sessionId],
  );

  const create = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      await backend.projectCreateBranch(projectId, trimmed, sessionId);
      const next = normalizeBranch(trimmed);
      setBranch(next);
      if (!isolated) rememberProjectBranch(projectId, next);
      setMenu((current) => {
        if (!current) return current;
        const rest = current.branches.filter((branch) => branch !== trimmed);
        return { ...current, current: next, branches: [trimmed, ...rest] };
      });
    },
    [isolated, projectId, sessionId],
  );

  return {
    visible: Boolean(projectId) && ready && isGit,
    label: gitBranchChipLabel(branch),
    current: branch,
    branches: menu?.branches ?? [],
    dirtyFiles: menu?.dirty_files ?? null,
    listError,
    setMenuActive,
    checkout,
    create,
  };
}
