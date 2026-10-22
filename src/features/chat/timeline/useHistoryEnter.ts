import { useLayoutEffect, useRef } from "react";

import { reduceHistoryEnter, type HistoryEnterCursor } from "./history-enter";

/** 空列表不开始淡入。第一包历史锚到最后一条；之后只有新的尾部才淡入。 */
export function useHistoryEnter(sessionId: string, keys: readonly string[]) {
  const sessionRef = useRef(sessionId);
  const cursorRef = useRef<HistoryEnterCursor>({ tail: null, ready: false });
  if (sessionRef.current !== sessionId) {
    sessionRef.current = sessionId;
    cursorRef.current = { tail: null, ready: false };
  }
  const frame = reduceHistoryEnter(cursorRef.current, keys);
  const nextTail = frame.cursor.tail;
  const nextReady = frame.cursor.ready;
  useLayoutEffect(() => {
    cursorRef.current = { tail: nextTail, ready: nextReady };
  }, [sessionId, nextTail, nextReady]);
  return frame.entering;
}
