// 任务的整条时间线：中途换过 Agent 时，前面几段接在现在这段前面。

import { useMemo } from "react";

import type { TaskEntry, TaskSession } from "@/features/tasks";
import { useSessionFeeds, type SessionFeedState } from "@/lib/daemon";
import type { AgentKind } from "@/types";

const NOT_READY: SessionFeedState = { ready: false, events: [], queue: [] };

export interface TaskTimeline {
  /** 各段接起来的时间线。 */
  all: SessionFeedState;
  /** 现在这段：作曲栏的目标、用量、计划模式只看它。 */
  current: SessionFeedState;
  /** 每段是哪个 Agent。 */
  agentOf: (sessionId: string) => AgentKind | undefined;
}

export function useTaskTimeline(task: TaskEntry, taskSession: TaskSession): TaskTimeline {
  const segments = useMemo(() => {
    const index = task.sessions.findIndex((session) => session.id === taskSession.id);
    return index < 0 ? [taskSession] : task.sessions.slice(0, index + 1);
  }, [task.sessions, taskSession]);
  const ids = useMemo(() => segments.map((session) => session.id), [segments]);
  const feeds = useSessionFeeds(ids);
  return useMemo(() => {
    const current = feeds[feeds.length - 1] ?? NOT_READY;
    const agents = new Map(segments.map((session) => [session.id, session.agent]));
    const all =
      feeds.length <= 1
        ? current
        : {
            ready: feeds.every((feed) => feed.ready),
            events: feeds.flatMap((feed) => feed.events),
            queue: current.queue,
          };
    return { all, current, agentOf: (sessionId: string) => agents.get(sessionId) };
  }, [feeds, segments]);
}
