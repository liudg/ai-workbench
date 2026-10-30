// 新会话的第一条消息：任务建好就跳过去，Agent 还在启动、daemon 还没记下这条消息时，先把它摆出来。

import { useEffect } from "react";
import { create } from "zustand";

import type { SessionEvent } from "@/types";

export interface SessionStart {
  text: string;
  images: string[];
  startedAt: number;
}

const useStarts = create<Record<string, SessionStart>>()(() => ({}));

export function beginSessionStart(sessionId: string, start: Omit<SessionStart, "startedAt">) {
  useStarts.setState({ [sessionId]: { ...start, startedAt: Date.now() } });
}

function endSessionStart(sessionId: string) {
  useStarts.setState((state) => {
    if (!(sessionId in state)) return state;
    const next = { ...state };
    delete next[sessionId];
    return next;
  });
}

/** 时间线里出现这条消息就算接上了；先报了错或失败也收起，错误由时间线自己画。 */
export function startSettled(events: readonly SessionEvent[]): boolean {
  for (const event of events) {
    if (event.kind === "user-message" || event.kind === "error") return true;
    if (event.kind === "status-changed" && event.status === "failed") return true;
  }
  return false;
}

export function useSessionStart(sessionId: string, events: readonly SessionEvent[], ready: boolean) {
  const start = useStarts((state) => state[sessionId] ?? null);
  const settled = Boolean(start) && ready && startSettled(events);
  useEffect(() => {
    if (start && settled) endSessionStart(sessionId);
  }, [sessionId, settled, start]);
  return settled ? null : start;
}
