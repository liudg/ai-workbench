import { useEffect, useState } from "react";

import type { ComposerHost } from "./host";
import { followPathPages, mentionSearchError } from "./mention-search";
import { mentionFiles, type MentionFile } from "./mentions";

/** `@` 后面有文字时，用已有的工作区路径筛选。取消的旧查询不覆盖新结果。 */
export function useMentionSearch(host: ComposerHost, query: string | null) {
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
      void followPathPages(
        () => host.filterPaths(query),
        (page) => {
          if (cancel) return;
          setHits(mentionFiles(page.paths, query));
          setError(null);
          setPending(!page.ready);
        },
        () => cancel,
      ).catch((err: unknown) => {
        if (cancel) return;
        setHits([]);
        setError(mentionSearchError(err));
        setPending(false);
      });
    }, 120);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
    // 同一会话里宿主每次渲染都是新的，按工作目录判断要不要重搜。
  }, [host.projectPath, query]);

  return { hits, pending, error };
}
