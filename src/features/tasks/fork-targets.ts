// 一个任务现在能分叉到哪些 Agent / 实例。命令菜单和侧栏的会话菜单共用。

import { profileForSessionAgent } from "../../shared/agent/identity.ts";
import {
  effectiveInstanceId,
  type AgentKind,
  type AgentProfile,
  type SessionStatus,
} from "../../types/index.ts";

/** `same` 是任务现在用的那个 Agent 实例。 */
export interface ForkTarget {
  agent: AgentKind;
  instanceId?: string;
  name: string;
  same: boolean;
}

interface ForkCandidateAgent {
  kind: AgentKind;
  instanceId?: string;
  displayName?: string;
}

/**
 * 回合在跑或在等输入时不能分叉。同一个实例：有原生线程且声明 `supports_fork` 时原生分叉，
 * 否则和换实例/换 Agent 一样交前文；别的实例或 Agent 要两边都能交接。
 */
export function forkTargets(
  current:
    | { agent: AgentKind; instanceId?: string; status: SessionStatus; nativeId?: string }
    | undefined,
  profiles: Partial<Record<string, AgentProfile>>,
  agents: readonly ForkCandidateAgent[] | null,
): ForkTarget[] {
  if (
    !current ||
    current.status === "starting" ||
    current.status === "running" ||
    current.status === "needs-input"
  ) {
    return [];
  }
  const currentInstKey = effectiveInstanceId(current.agent, current.instanceId);
  const profileOf = (kind: AgentKind, instanceId?: string) =>
    profileForSessionAgent(kind, profiles, instanceId);
  const capsOf = (kind: AgentKind, instanceId?: string) =>
    profileOf(kind, instanceId)?.capabilities;
  const handsOff = (kind: AgentKind, instanceId?: string) =>
    capsOf(kind, instanceId)?.supports_context_handoff === true;
  const nameOf = (kind: AgentKind, instanceId: string | undefined, fallback: string) =>
    profileOf(kind, instanceId)?.display_name?.trim() || fallback;

  const targets: ForkTarget[] = [];
  const native =
    Boolean(current.nativeId) && capsOf(current.agent, current.instanceId)?.supports_fork === true;
  if (native || handsOff(current.agent, current.instanceId)) {
    targets.push({
      agent: current.agent,
      instanceId: currentInstKey,
      name: nameOf(current.agent, current.instanceId, current.agent),
      same: true,
    });
  }
  if (handsOff(current.agent, current.instanceId)) {
    const seen = new Set<string>([currentInstKey]);
    for (const item of agents ?? []) {
      const targetKey = effectiveInstanceId(item.kind, item.instanceId);
      if (seen.has(targetKey)) continue;
      if (handsOff(item.kind, item.instanceId)) {
        seen.add(targetKey);
        const fallback = item.displayName?.trim() || item.kind;
        targets.push({
          agent: item.kind,
          instanceId: targetKey,
          name: nameOf(item.kind, item.instanceId, fallback),
          same: false,
        });
      }
    }
  }
  return targets;
}
