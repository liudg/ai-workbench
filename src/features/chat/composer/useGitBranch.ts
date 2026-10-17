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
 * 当前项目是不是 git 仓库、检出了哪条分支。
 * 菜单打开时再读本地分支和未提交文件数。外部切换靠轮询跟上。
 */
export function useGitBranch(projectId: string) {
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

    const refresh = async () => {
      const seen = projectBranchStamp(projectId);
      try {
        const git = await backend.projectIsGit(projectId);
        if (cancel || projectBranchStamp(projectId) !== seen) return;
        if (!git) {
          readyRef.current = true;
          setReady(true);
          setIsGit(false);
          setBranch(null);
          rememberProjectBranch(projectId, null);
          return;
        }
        const value = await backend.projectBranch(projectId);
        if (cancel || projectBranchStamp(projectId) !== seen) return;
        const next = normalizeBranch(value);
        readyRef.current = true;
        setReady(true);
        setIsGit(true);
        setBranch(next);
        rememberProjectBranch(projectId, next);
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
  }, [projectId]);

  const projectRef = useRef(projectId);
  projectRef.current = projectId;

  const loadMenu = useCallback(async () => {
    if (!projectId) return;
    const id = projectId;
    const seen = projectBranchStamp(id);
    try {
      const snapshot = await backend.projectGitBranches(id);
      if (projectRef.current !== id || projectBranchStamp(id) !== seen) return;
      setMenu(snapshot);
      setListError(null);
      const next = normalizeBranch(snapshot.current);
      setBranch(next);
      setIsGit(true);
      setReady(true);
      readyRef.current = true;
      rememberProjectBranch(id, next);
    } catch (error) {
      if (projectRef.current !== id) return;
      setListError(userFacingMessage(error) ?? "无法读取分支");
    }
  }, [projectId]);

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
      await backend.projectCheckoutBranch(projectId, name);
      const next = normalizeBranch(name);
      setBranch(next);
      rememberProjectBranch(projectId, next);
      setMenu((current) => (current ? { ...current, current: next } : current));
    },
    [projectId],
  );

  const create = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      await backend.projectCreateBranch(projectId, trimmed);
      const next = normalizeBranch(trimmed);
      setBranch(next);
      rememberProjectBranch(projectId, next);
      setMenu((current) => {
        if (!current) return current;
        const rest = current.branches.filter((branch) => branch !== trimmed);
        return { ...current, current: next, branches: [trimmed, ...rest] };
      });
    },
    [projectId],
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
