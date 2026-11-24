import { useEffect, useRef } from "react";

import type { TaskSearchHit } from "@/features/tasks";
import { cn } from "@/lib/utils";
import { HighlightedSnippet, resolveSearchProjectName, searchHitRoleLabel } from "@/shared/search";

export function SidebarSearchResults({
  query,
  hits,
  loading,
  activeIndex,
  projects,
  onActiveIndex,
  onSelectHit,
}: {
  query: string;
  hits: readonly TaskSearchHit[];
  loading: boolean;
  activeIndex: number;
  projects: readonly { id: string; name: string }[];
  onActiveIndex: (index: number) => void;
  onSelectHit: (hit: TaskSearchHit) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector("[data-sidebar-search-hit][data-active='true']")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, hits]);

  if (loading && hits.length === 0) {
    return (
      <div
        data-sidebar-search-results=""
        data-sidebar-search-loading=""
        className="px-2 py-8 text-center text-xs text-wb-fg-3"
      >
        <span className="live-shimmer">正在搜索…</span>
      </div>
    );
  }

  if (!loading && hits.length === 0) {
    return (
      <div
        data-sidebar-search-results=""
        data-sidebar-search-empty=""
        className="px-2 py-8 text-center text-xs text-wb-fg-3"
      >
        未找到匹配的会话或消息
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="搜索结果"
      data-sidebar-search-results=""
      className="space-y-1 py-1"
    >
      {hits.map((hit, index) => {
        const selected = index === activeIndex;
        const title = hit.taskTitle.trim() || "未命名会话";
        const projectName = resolveSearchProjectName(hit.projectId, projects);
        const roleLabel = searchHitRoleLabel(hit.role);
        const isArchived = hit.archivedAt != null;
        const hitKey = `${hit.taskId}:${hit.role}:${hit.eventId ?? hit.seq ?? 0}`;

        return (
          <button
            key={hitKey}
            type="button"
            role="option"
            aria-selected={selected}
            data-sidebar-search-hit={hit.taskId}
            data-search-event-id={hit.eventId ?? ""}
            data-active={selected ? "true" : "false"}
            className={cn(
              "flex w-full flex-col gap-1 rounded-lg px-2 py-1.5 text-left transition-colors",
              selected ? "wb-sidebar-active" : "hover:bg-wb-hover",
            )}
            onMouseEnter={() => onActiveIndex(index)}
            onClick={() => onSelectHit(hit)}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <HighlightedSnippet
                snippet={title}
                query={query}
                className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-4 text-wb-fg"
              />
              <span
                data-search-hit-role={hit.role}
                className="shrink-0 rounded border border-wb-border bg-wb-elev/80 px-1 py-px text-[10px] leading-3.5 text-wb-fg-2"
              >
                {roleLabel}
              </span>
            </div>

            <div className="flex min-w-0 items-center gap-1 text-[10.5px] leading-3.5 text-wb-fg-3">
              <span
                data-search-hit-project=""
                className="max-w-[148px] truncate rounded bg-wb-elev/70 px-1.5 py-px text-wb-fg-3"
              >
                {projectName}
              </span>
              {isArchived ? (
                <span
                  data-search-hit-archived=""
                  className="shrink-0 rounded border border-wb-border bg-wb-elev/70 px-1 py-px text-[10px] leading-3.5 text-wb-fg-3"
                >
                  已归档
                </span>
              ) : null}
            </div>

            {hit.role !== "title" &&
            hit.snippet.trim().length > 0 &&
            hit.snippet.trim() !== title ? (
              <HighlightedSnippet
                snippet={hit.snippet}
                query={query}
                className="line-clamp-2 break-words text-[11.5px] leading-4 text-wb-fg-2"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
