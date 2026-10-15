import type { AgentKind, AgentProfile } from "@/types";

export interface AgentIdentity {
  name: string;
  icon: string | null;
}

export function profileForSessionAgent(
  agent: AgentKind,
  profiles: Partial<Record<AgentKind, AgentProfile>> | null | undefined,
): AgentProfile | undefined {
  const profile = profiles?.[agent];
  if (!profile || profile.kind !== agent) return undefined;
  return profile;
}

/** 只用这一条会话自己的适配器资料。对不上 kind 时当没有。 */
export function agentIdentity(
  agent: AgentKind,
  profile: AgentProfile | undefined,
): AgentIdentity | null {
  if (!profile || profile.kind !== agent) return null;
  const name = profile.display_name?.trim() ?? "";
  const icon = profile.icon?.trim() || null;
  if (!name && !icon) return null;
  return { name, icon };
}
