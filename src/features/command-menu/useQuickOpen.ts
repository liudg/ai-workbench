import { useEffect, useState } from "react";

import { daemon } from "@/lib/daemon";

export type QuickOpenPhase = "idle" | "loading" | "ready" | "error" | "no-project";

/** 跳转文件读哪里：面板所在的会话，或者还没建会话时的项目。 */
export type QuickOpenScope = { sessionId: string } | { projectId: string };

interface IndexedPaths {
  paths: string[];
  truncated: boolean;
  cancelled: boolean;
  ready: boolean;
}

/** 跳转文件读现有路径索引。空查询也列一批文件；索引还没建完就接着要。 */
export function useQuickOpen(scope: QuickOpenScope | null, query: string, enabled: boolean) {
  const [paths, setPaths] = useState<string[]>([]);
  const [phase, setPhase] = useState<QuickOpenPhase>("idle");
  const scopeKey = scope ? JSON.stringify(scope) : "";

  useEffect(() => {
    if (!enabled) return;
    if (!scope) {
      setPaths([]);
      setPhase("no-project");
      return;
    }
    let stopped = false;
    setPaths([]);
    setPhase("loading");
    const delay = query.trim() ? 80 : 0;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          for (let hop = 0; hop < 20000; hop += 1) {
            if (stopped) return;
            const result = await daemon.call<IndexedPaths>("files.quickOpen", { ...scope, query });
            if (stopped) return;
            if (!result.cancelled) setPaths(result.paths);
            const ready = result.ready !== false && !result.cancelled;
            if (ready) {
              setPhase("ready");
              return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 40));
          }
          if (!stopped) setPhase("error");
        } catch {
          if (stopped) return;
          setPaths([]);
          setPhase("error");
        }
      })();
    }, delay);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // 范围按内容比较，调用方每次渲染给的对象都是新的。
  }, [enabled, scopeKey, query]);

  if (!enabled) return { paths: [] as string[], phase: "idle" as const };
  if (!scope) return { paths: [] as string[], phase: "no-project" as const };
  return { paths, phase: phase === "idle" ? "loading" : phase };
}
