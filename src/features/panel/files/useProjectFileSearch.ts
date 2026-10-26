import { useEffect, useState } from "react";

import type { FileSearchHit } from "@/lib/ipc";
import { usePanelData } from "../core/PanelProvider";

let fileSearchSerial = 0;

/** 在工作区里分段搜索。空查询不发请求。 */
export function useProjectFileSearch(
  projectId: string,
  query: string,
  mask: string,
  sessionId?: string,
) {
  const data = usePanelData();
  const [hits, setHits] = useState<FileSearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(true);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setTruncated(false);
      setError("");
      setLoading(false);
      setDone(true);
      return;
    }
    let stopped = false;
    const searchId = ++fileSearchSerial;
    const timer = window.setTimeout(() => {
      void (async () => {
        setHits([]);
        setTruncated(false);
        setError("");
        setLoading(true);
        setDone(false);
        try {
          for (let hop = 0; hop < 20000; hop += 1) {
            if (stopped) return;
            const page = await data.searchFiles(projectId, q, mask, searchId, sessionId ?? "");
            if (stopped || page.cancelled) return;
            setHits((current) => (sameHits(current, page.hits) ? current : page.hits));
            setTruncated(page.truncated);
            setError("");
            if (page.done) {
              setDone(true);
              setLoading(false);
              return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 40));
          }
          if (!stopped) {
            setError("搜索没有完成");
            setDone(true);
            setLoading(false);
          }
        } catch (err: unknown) {
          if (stopped) return;
          setHits([]);
          setTruncated(false);
          setDone(true);
          setError(typeof err === "string" && err.trim() ? err : "搜索失败");
          setLoading(false);
        }
      })();
    }, 200);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [data, mask, projectId, query, sessionId]);

  return { hits, truncated, error, loading, done };
}

function sameHits(current: FileSearchHit[], next: FileSearchHit[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((hit, index) => {
    const other = next[index];
    return hit.path === other.path && hit.line === other.line && hit.kind === other.kind && hit.text === other.text;
  });
}
