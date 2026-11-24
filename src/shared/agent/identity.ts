import { effectiveInstanceId, type AgentKind, type AgentProfile } from "../../types/index.ts";

export interface AgentIdentity {
  name: string;
  icon: string | null;
  monochrome?: boolean;
  accentColor?: string | null;
}

export function profileForSessionAgent(
  agent: AgentKind,
  profiles: Partial<Record<string, AgentProfile>> | null | undefined,
  instanceId?: string | null,
): AgentProfile | undefined {
  const key = effectiveInstanceId(agent, instanceId);
  const profile = profiles?.[key] ?? profiles?.[agent];
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
  const accentColor = profile.accent_color?.trim() || null;
  if (!name && !icon) return null;
  return {
    name,
    icon,
    ...(profile.monochrome_icon ? { monochrome: true } : {}),
    ...(accentColor ? { accentColor } : {}),
  };
}
