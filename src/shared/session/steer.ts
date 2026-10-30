// 引导：回合还在跑时补进去的用户消息。它属于正在跑的那一轮，不另开一轮。
// 时间线的分轮和「本轮变更」都按这个切。

import type { SessionEvent } from "../../types/index.ts";

/** Agent 在回合里产出的东西。看到它才说明回合已经开始干活。 */
function isAgentWork(event: SessionEvent): boolean {
  switch (event.kind) {
    case "agent-message":
    case "thinking":
    case "tool-call":
    case "prompt":
    case "plan-text":
    case "plan-steps":
    case "file-change":
    case "turn-changes":
    case "review-note":
    case "review-findings":
      return true;
    default:
      return false;
  }
}

/**
 * 每条事件是不是引导。用户消息前面最近的 `turn-anchor` 之后 Agent 已经干过活、
 * 中间又没有回合结束的状态，就是引导。新回合的锚点紧挨着用户消息，前面没有活，不算。
 * 没有锚点的会话（不报回合的 Agent）一律不算引导。
 */
export function steerFlags(events: readonly SessionEvent[]): boolean[] {
  const flags: boolean[] = [];
  let anchored = false;
  let working = false;
  for (const event of events) {
    let steer = false;
    if (event.kind === "turn-anchor") {
      anchored = true;
      working = false;
    } else if (event.kind === "handoff") {
      anchored = false;
      working = false;
    } else if (event.kind === "status-changed") {
      if (event.status !== "running" && event.status !== "needs-input") working = false;
    } else if (event.kind === "user-message") {
      steer = anchored && working;
    } else if (anchored && isAgentWork(event)) {
      working = true;
    }
    flags.push(steer);
  }
  return flags;
}
