import { useEffect, useRef, useState } from "react";

import type { BackgroundTaskEvent } from "./background-task-display";

const POLL_MS = 1_000;

interface LoadedOutput {
  path: string;
  text: string;
  settled: boolean;
}

const EMPTY_LOADED: LoadedOutput = { path: "", text: "", settled: false };

export interface BackgroundOutputState {
  text: string;
  loading: boolean;
  settled: boolean;
}

/**
 * 仅在展开查看且任务带有 `output_file` 时按需读取输出文本：
 * - 用 ref 持有读取函数，不因流式事件或输入重渲染触发重复 RPC；
 * - 首次展开与进入终态时总是读取一次（即便窗口当前隐藏也不漏终态内容）；
 * - 记录 `settled`，避免首次读取返回前提前判定无内容而禁用展开按钮。
 */
export function useBackgroundOutput(
  task: BackgroundTaskEvent | undefined,
  active: boolean,
  readFile: ((path: string) => Promise<string>) | undefined,
): BackgroundOutputState {
  const path = task?.output_file?.trim() ?? "";
  const status = task?.status;
  const hasReader = Boolean(readFile);
  const readRef = useRef(readFile);
  readRef.current = readFile;

  const [loaded, setLoaded] = useState<LoadedOutput>(EMPTY_LOADED);

  useEffect(() => {
    if (!active || !path || !hasReader) return;
    let cancelled = false;
    let inflight = false;

    const pull = (skipWhenHidden: boolean) => {
      const reader = readRef.current;
      if (cancelled || inflight || !reader) return;
      if (
        skipWhenHidden &&
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      inflight = true;
      void reader(path)
        .then((next) => {
          if (!cancelled) {
            setLoaded((prev) =>
              prev.path === path && prev.text === next && prev.settled
                ? prev
                : { path, text: next, settled: true },
            );
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLoaded((prev) =>
              prev.path === path && prev.settled ? prev : { path, text: "", settled: true },
            );
          }
        })
        .finally(() => {
          inflight = false;
        });
    };

    pull(false);
    if (status !== "running") {
      return () => {
        cancelled = true;
      };
    }

    const timer = window.setInterval(() => pull(true), POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") pull(false);
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [active, hasReader, path, status]);

  if (!path || !hasReader) {
    return { text: "", loading: false, settled: true };
  }
  const isCurrent = loaded.path === path;
  const settled = isCurrent && loaded.settled;
  return {
    text: isCurrent ? loaded.text : "",
    loading: active && !settled,
    settled,
  };
}
