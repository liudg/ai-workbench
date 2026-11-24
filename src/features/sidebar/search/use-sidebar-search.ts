import { useCallback, useState } from "react";

import {
  DEFAULT_SEARCH_DEBOUNCE_MS,
  useTaskSearchHits,
  type TaskSearchHit,
} from "@/features/tasks";
import { showError } from "@/shared/shell/error-banner";
import { openTask } from "@/shared/shell/navigation";

const SIDEBAR_SEARCH_DEBOUNCE_MS = DEFAULT_SEARCH_DEBOUNCE_MS;
const SIDEBAR_SEARCH_LIMIT = 40;

export function useSidebarSearch(debounceMs = SIDEBAR_SEARCH_DEBOUNCE_MS) {
  const [query, setQueryState] = useState("");
  const [includeArchived, setIncludeArchivedState] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const { trimmedQuery, hits, loading } = useTaskSearchHits(query, {
    includeArchived,
    limit: SIDEBAR_SEARCH_LIMIT,
    debounceMs,
    onError: showError,
  });
  const isSearching = trimmedQuery.length > 0;

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
    setActiveIndex(0);
  }, []);

  const toggleIncludeArchived = useCallback(() => {
    setIncludeArchivedState((prev) => !prev);
    setActiveIndex(0);
  }, []);

  const clearSearch = useCallback(() => {
    setQueryState("");
    setActiveIndex(0);
  }, []);

  const safeActiveIndex = hits.length === 0 ? 0 : Math.min(activeIndex, hits.length - 1);

  const selectHit = useCallback(
    (hit: TaskSearchHit) => {
      if (!trimmedQuery) return;
      openTask(hit.taskId, hit.projectId ?? null, {
        eventId: hit.eventId,
        query: trimmedQuery,
      });
    },
    [trimmedQuery],
  );

  return {
    query,
    trimmedQuery,
    isSearching,
    includeArchived,
    hits,
    loading,
    activeIndex: safeActiveIndex,
    setQuery,
    setActiveIndex,
    toggleIncludeArchived,
    clearSearch,
    selectHit,
  };
}
