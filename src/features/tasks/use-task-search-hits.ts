// 侧栏与命令面板共用的全文检索防抖 Hook，绑定结果所属 query 以杜绝防抖期间展示或回车误跳旧结果。

import { useEffect, useRef, useState } from "react";

import * as tasksApi from "./api";
import type { TaskSearchHit } from "./types";

export const DEFAULT_SEARCH_DEBOUNCE_MS = 150;

export interface UseTaskSearchHitsOptions {
  enabled?: boolean;
  includeArchived?: boolean;
  limit?: number;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

export function useTaskSearchHits(
  query: string,
  options: UseTaskSearchHitsOptions = {},
): {
  trimmedQuery: string;
  hits: TaskSearchHit[];
  loading: boolean;
} {
  const {
    enabled = true,
    includeArchived = false,
    limit = 30,
    debounceMs = DEFAULT_SEARCH_DEBOUNCE_MS,
    onError,
  } = options;
  const trimmedQuery = query.trim();
  const active = enabled && trimmedQuery.length > 0;

  const [result, setResult] = useState<{
    key: string;
    hits: TaskSearchHit[];
  }>({ key: "", hits: [] });
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const currentKey = active ? `${includeArchived ? "1" : "0"}:${limit}:${trimmedQuery}` : "";

  useEffect(() => {
    const reqId = ++requestIdRef.current;
    if (!active) {
      setLoadingKey(null);
      return;
    }

    setLoadingKey(currentKey);
    const timer = setTimeout(() => {
      tasksApi
        .searchTasks({
          query: trimmedQuery,
          includeArchived,
          limit,
        })
        .then((nextHits) => {
          if (requestIdRef.current !== reqId) return;
          setResult({ key: currentKey, hits: nextHits });
          setLoadingKey((prev) => (prev === currentKey ? null : prev));
        })
        .catch((error) => {
          if (requestIdRef.current !== reqId) return;
          setResult({ key: currentKey, hits: [] });
          setLoadingKey((prev) => (prev === currentKey ? null : prev));
          onErrorRef.current?.(error);
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
    };
  }, [active, currentKey, debounceMs, includeArchived, limit, trimmedQuery]);

  if (!active) {
    return { trimmedQuery, hits: [], loading: false };
  }

  const matched = result.key === currentKey;
  return {
    trimmedQuery,
    hits: matched ? result.hits : [],
    loading: !matched || loadingKey === currentKey,
  };
}
