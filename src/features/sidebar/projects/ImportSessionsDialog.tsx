import { useEffect, useRef, type ReactNode } from "react";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Project } from "@/features/projects";
import { cn, displayPath } from "@/lib/utils";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { relativeSessionTime } from "@/shared/format/relative-time";
import { useImportSessions } from "./use-import-sessions";

export function ImportSessionsDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const {
    loading,
    loadError,
    retry,
    tabs,
    active,
    pick,
    activeName,
    rows,
    pageLoading,
    pageLoaded,
    pageError,
    retryPage,
    hasMore,
    loadMore,
    selected,
    toggle,
    allSelected,
    toggleAll,
    busy,
    submit,
    imported,
    failures,
  } = useImportSessions(project, onClose);
  const now = Date.now();
  const count = selected.size;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="flex max-h-[80vh] max-w-[520px] flex-col gap-4 overflow-hidden [&>*]:min-w-0">
        <DialogHeader className="pr-6">
          <DialogTitle>导入历史会话</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs" title={project.path}>
            {displayPath(project.path)}
          </DialogDescription>
        </DialogHeader>

        {loading && <p className="py-8 text-center text-sm text-wb-fg-3">正在读取会话…</p>}

        {loadError && <ErrorLine message={loadError} onRetry={retry} />}

        {imported > 0 && <p className="text-xs text-wb-ok">已导入 {imported} 个会话。</p>}
        {failures.length > 0 && (
          <div className="space-y-1 rounded-lg border border-wb-danger/25 bg-wb-danger-soft px-3 py-2 text-xs text-wb-danger">
            {failures.map((failure) => (
              <p key={`${failure.agent}:${failure.nativeId}`} className="break-words">
                {failure.title.trim() || "无标题"}：{failure.message}
              </p>
            ))}
          </div>
        )}

        {tabs.length > 0 && (
          <div className="-mb-1 flex flex-wrap gap-1" role="tablist" aria-label="Agent">
            {tabs.map((tab) => {
              const isActive = tab.agent === active;
              return (
                <button
                  key={tab.agent}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  data-import-agent={tab.agent}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors",
                    isActive
                      ? "bg-wb-active font-medium text-wb-fg"
                      : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
                  )}
                  onClick={() => pick(tab.agent)}
                >
                  <SessionAgentIcon identity={tab.identity} className="h-4 w-4" />
                  <span>{tab.name}</span>
                  {tab.failed ? (
                    <span className="text-xs text-wb-danger">!</span>
                  ) : (
                    tab.count !== null && <span className="text-xs text-wb-fg-3">{tab.count}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {active && !pageLoaded && pageLoading && (
          <p className="py-8 text-center text-sm text-wb-fg-3">正在读取会话…</p>
        )}

        {active && !pageLoaded && pageError && <ErrorLine message={pageError} onRetry={retryPage} />}

        {active && pageLoaded && rows.length === 0 && !hasMore && (
          <p className="py-8 text-center text-sm text-wb-fg-3">该目录下没有可导入会话</p>
        )}

        {rows.length > 0 && (
          <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-wb-border bg-wb-elev/40">
            <button
              type="button"
              className="flex items-center gap-2.5 border-b border-wb-border px-3 py-2 text-left text-xs text-wb-fg-2 hover:bg-wb-hover"
              onClick={toggleAll}
              disabled={busy}
            >
              <Checkbox checked={allSelected} />
              全选（{rows.length}）
            </button>
            <ScrollList onEnd={loadMore} watch={`${active}:${rows.length}`} label={`${activeName} 可导入的会话`}>
              {rows.map((row) => {
                const checked = selected.has(row.key);
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    data-import-row={row.key}
                    disabled={busy}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-wb-hover",
                      checked && "bg-wb-accent-soft",
                    )}
                    onClick={() => toggle(row)}
                  >
                    <Checkbox checked={checked} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-wb-fg" title={row.item.title}>
                      {row.item.title.trim() || "无标题"}
                    </span>
                    <span className="shrink-0 text-xs text-wb-fg-3">
                      {relativeSessionTime(row.item.updatedAt, now)}
                    </span>
                  </button>
                );
              })}
              {pageLoading && <p className="px-3 py-2 text-center text-xs text-wb-fg-3">正在加载…</p>}
              {pageError && (
                <div className="px-3 py-2">
                  <ErrorLine message={pageError} onRetry={retryPage} />
                </div>
              )}
            </ScrollList>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {failures.length > 0 ? "关闭" : "取消"}
          </Button>
          <Button type="button" disabled={count === 0 || busy} onClick={() => void submit()}>
            {busy ? "正在导入…" : count > 0 ? `导入 ${count} 个` : "导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ErrorLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-wb-danger/25 bg-wb-danger-soft px-3 py-2 text-xs text-wb-danger">
      <span className="min-w-0 break-words">{message}</span>
      <button type="button" className="shrink-0 text-wb-fg-2 hover:text-wb-fg" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

/** 滚到底部附近就要下一页。读回来以后底部还在视野里会接着要，直到填满或者没有了。 */
function ScrollList({
  onEnd,
  watch,
  label,
  children,
}: {
  onEnd: () => void;
  watch: string;
  label: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    const root = rootRef.current;
    const end = endRef.current;
    if (!root || !end) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onEndRef.current();
      },
      { root, rootMargin: "120px" },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [watch]);

  return (
    <div ref={rootRef} className="min-h-0 overflow-y-auto" role="listbox" aria-multiselectable aria-label={label}>
      {children}
      <div ref={endRef} aria-hidden className="h-px" />
    </div>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
        checked ? "border-wb-accent bg-wb-accent text-white" : "border-wb-border-strong",
      )}
    >
      {checked && <Check className="h-3 w-3" strokeWidth={3} />}
    </span>
  );
}
