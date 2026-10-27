/** Codex `followUpQueueMode`。`queue` 把回合中的后续输入排进队列，`steer` 写进当前回合。 */

export type FollowUpQueueMode = "queue" | "steer";

export function toggleFollowUpQueueMode(mode: FollowUpQueueMode): FollowUpQueueMode {
  return mode === "queue" ? "steer" : "queue";
}
