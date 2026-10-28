// 与 crates/aiwb-core/src/rpc.rs 的主题名一致。

export const TOPIC_PROJECTS = "projects";
export const TOPIC_TASKS = "tasks";
export const TOPIC_AGENT_UPGRADES = "agents.upgrades";

export function sessionTopic(sessionId: string): string {
  return `session:${sessionId}`;
}
