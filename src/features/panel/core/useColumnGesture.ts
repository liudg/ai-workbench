import { useRef } from "react";

import { dragBase } from "./layout";

/**
 * 一次拖拽里的宽度。
 * 渲染时不能把 store 里还没跟上的旧宽度写回来，否则同一笔拖拽会跳回上一帧。
 * 手势开始用当前显示宽度；切会话时丢掉上一笔。
 */
export function useColumnGesture(shown: number, scope: string) {
  const gesture = useRef(false);
  const live = useRef<number | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const scopeRef = useRef(scope);
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    gesture.current = false;
    live.current = null;
  }

  const base = () => {
    const next = dragBase(gesture.current, live.current, shownRef.current);
    gesture.current = true;
    return next;
  };
  const remember = (next: number) => {
    live.current = next;
  };
  const settle = () => {
    gesture.current = false;
  };
  return { base, remember, settle };
}
