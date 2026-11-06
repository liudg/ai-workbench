// 一个任务现在能分叉到哪些 Agent。命令菜单和侧栏的会话菜单共用。

import type { AgentKind, AgentProfile, SessionStatus } from "@/types";

/** `same` 是任务现在用的那个 Agent。 */
export interface ForkTarget {
  agent: AgentKind;
  name: string;
  same: boolean;
}

/**
 * 回合在跑或在等输入时不能分叉。同一个 Agent：有原生线程且声明 `supports_fork` 时原生分叉，
 * 否则和换 Agent 一样交前文；别的 Agent 要两边都能交接。
 */
export function forkTargets(
  current: { agent: AgentKind; status: SessionStatus; nativeId?: string } | undefined,
  profiles: Partial<Record<AgentKind, AgentProfile>>,
  agents: readonly { kind: AgentKind; display_name: string }[] | null,
): ForkTarget[] {
  if (!current || current.status === "starting" || current.status === "running" || current.status === "needs-input") return [];
  const caps = (kind: AgentKind) => profiles[kind]?.capabilities;
  const handsOff = (kind: AgentKind) => caps(kind)?.supports_context_handoff === true;
  const name = (kind: AgentKind, fallback: string) => profiles[kind]?.display_name || fallback;
  const targets: ForkTarget[] = [];
  const native = Boolean(current.nativeId) && caps(current.agent)?.supports_fork === true;
  if (native || handsOff(current.agent)) {
    targets.push({ agent: current.agent, name: name(current.agent, current.agent), same: true });
  }
  if (handsOff(current.agent)) {
    for (const item of agents ?? []) {
      if (item.kind !== current.agent && handsOff(item.kind)) {
        targets.push({ agent: item.kind, name: name(item.kind, item.display_name), same: false });
      }
    }
  }
  return targets;
}
