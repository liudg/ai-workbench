import { useEffect, useState } from "react";

import { searchMentionPaths } from "./composer-backend";
import { mentionFiles, type MentionFile } from "./mentions";

/** `@` 后面有文字时，用已有的工作区路径筛选。取消的旧查询不覆盖新结果。 */
export function useMentionSearch(projectId: string, query: string | null) {
  const [hits, setHits] = useState<MentionFile[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query) {
      setHits([]);
      setPending(false);
      setError(null);
      return;
    }
    let cancel = false;
    setPending(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void searchMentionPaths(projectId, query).then(
        (result) => {
          if (cancel || result.cancelled) return;
          setHits(mentionFiles(result.paths, query));
          setError(null);
          setPending(false);
        },
        (err: unknown) => {
          if (cancel) return;
          setHits([]);
          setError(err instanceof Error ? err.message : String(err));
          setPending(false);
        },
      );
    }, 120);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [projectId, query]);

  return { hits, pending, error };
}
