import { useLayoutEffect, useRef } from "react";

import { keysEnteringAfterTail } from "./history-enter";

/** 会话第一帧的回合保持静止。尾部之后新出现的回合才淡入。 */
export function useHistoryEnter(sessionId: string, keys: readonly string[]) {
  const sessionRef = useRef(sessionId);
  const tailRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  if (sessionRef.current !== sessionId) {
    sessionRef.current = sessionId;
    tailRef.current = null;
    readyRef.current = false;
  }
  const entering = keysEnteringAfterTail(keys, tailRef.current, readyRef.current);
  useLayoutEffect(() => {
    tailRef.current = keys.length > 0 ? (keys[keys.length - 1] ?? null) : null;
    readyRef.current = true;
  }, [sessionId, keys]);
  return entering;
}
