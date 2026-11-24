import { sidebarScopeKey, useSidebarViewStore } from "../sidebar-view-store";
import type { SidebarTask } from "../sidebar-task";
import { SessionRows } from "./SessionRows";
import { nestLines, splitSubtasks } from "./session-nesting";
import { SESSION_PREVIEW_LIMIT, sidebarSessionWindow } from "./session-order";

const rowButtonClass =
  "w-full rounded-lg py-1 pl-[46px] pr-2 text-left text-xs text-wb-fg-3 hover:bg-wb-hover hover:text-wb-fg-2";

export function SessionList({
  tasks,
  activeTaskId,
  scope,
  jumpIndexByTaskId,
}: {
  tasks: readonly SidebarTask[];
  activeTaskId: string | null;
  scope?: string;
  jumpIndexByTaskId?: ReadonlyMap<string, number>;
}) {
  const resolvedScope = scope ?? sidebarScopeKey(tasks[0]?.projectId ?? null);
  const visibleLimit = useSidebarViewStore(
    (state) => state.visibleLimitByScope[resolvedScope] ?? SESSION_PREVIEW_LIMIT,
  );
  const collapsed = useSidebarViewStore((state) => state.collapsedSubtasks);
  const revealMoreInScope = useSidebarViewStore((state) => state.revealMoreInScope);
  const collapseScopeLimit = useSidebarViewStore((state) => state.collapseScopeLimit);
  const toggleSubtaskCollapsed = useSidebarViewStore((state) => state.toggleSubtaskCollapsed);

  const { roots, childrenOf } = splitSubtasks(tasks);
  const pinnedIds = roots.filter((task) => task.pinned).map((task) => task.id);
  const { visible, canRevealMore, canCollapse } = sidebarSessionWindow(roots, visibleLimit, pinnedIds);

  return (
    <div className="mt-0.5">
      <SessionRows
        lines={nestLines(visible, childrenOf, collapsed)}
        activeTaskId={activeTaskId}
        jumpIndexByTaskId={jumpIndexByTaskId}
        onToggle={toggleSubtaskCollapsed}
      />
      {(canRevealMore || canCollapse) && (
        <div className="pt-0.5">
          {canRevealMore && (
            <button
              type="button"
              className={rowButtonClass}
              onClick={() => revealMoreInScope(resolvedScope)}
            >
              展开显示
            </button>
          )}
          {canCollapse && (
            <button
              type="button"
              className={rowButtonClass}
              onClick={() => collapseScopeLimit(resolvedScope)}
            >
              收起
            </button>
          )}
        </div>
      )}
    </div>
  );
}
