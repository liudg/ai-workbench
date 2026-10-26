// 跑完后还没点开的会话。看着任务列表的状态变化打标，点进去就清掉；记在本地，刷新还在。

import { useEffect, useSyncExternalStore } from "react";

import { currentSession, type TaskEntry } from "@/features/tasks";
import {
  browserUnreadStorage,
  readUnreadFinishedIds,
  reconcileUnreadFinished,
  sameUnreadIds,
  writeUnreadFinishedIds,
  type UnreadSession,
} from "@/shared/unread-finished";

let unreadIds = readUnreadFinishedIds(browserUnreadStorage());
let seen: Record<string, UnreadSession[]> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 应用里调一次。任务列表还没到时不调用，免得把第一份快照当成状态变化。 */
export function useUnreadTracking(tasks: readonly TaskEntry[] | null, visibleTaskId: string | null) {
  useEffect(() => {
    if (!tasks) return;
    const next = { all: tasks.map((task) => ({ id: task.id, status: currentSession(task)?.status })) };
    const updated = reconcileUnreadFinished({
      previousSessions: seen ?? next,
      nextSessions: next,
      previousUnread: unreadIds,
      visibleSessionId: visibleTaskId,
    });
    seen = next;
    if (sameUnreadIds(updated, unreadIds)) return;
    unreadIds = updated;
    writeUnreadFinishedIds(browserUnreadStorage(), updated);
    for (const listener of listeners) listener();
  }, [tasks, visibleTaskId]);
}

export function useUnreadFinished(taskId: string): boolean {
  return useSyncExternalStore(subscribe, () => unreadIds.includes(taskId));
}
