// 注意力：daemon 的投影（crates/aiwb-core/src/attention.rs）怎么画、怎么排。侧栏、看板、命令菜单共用。

export type AttentionState = "starting" | "new" | "needs-input" | "failed" | "working" | "done" | "idle";

export interface Attention {
  state: AttentionState;
  /** 回合停下来时你没在看，看一眼就清掉。 */
  unread: boolean;
  /** 在等你批准还是回答。 */
  ask?: "approval" | "input";
  /** 提问、错误或 Agent 最后说的话，单行。 */
  preview?: string;
  updatedAt: number;
}

export type AttentionTone = "approval" | "input" | "failed" | "working" | "done";

/**
 * 状态药丸。颜色只用来提示「要你看」：待批准、待回答、没看过的失败和完成；运行中是灰色的呼吸点；
 * 看过的结果和闲着的会话不画。照 t3code `apps/web/src/components/Sidebar.logic.ts` 的 `resolveThreadStatusPill`。
 */
export interface AttentionPillView {
  tone: AttentionTone;
  label: string;
  textClass: string;
  dotClass: string;
  pulse: boolean;
}

export function attentionPill(attention: Attention | undefined): AttentionPillView | null {
  if (!attention) return null;
  switch (attention.state) {
    case "needs-input":
      return attention.ask === "approval"
        ? pill("approval", "待批准", "text-wb-warn", "bg-wb-warn")
        : pill("input", "待回答", "text-wb-accent-ink", "bg-wb-accent");
    case "starting":
      return { ...pill("working", "正在启动", "text-wb-fg-3", "bg-wb-fg-3"), pulse: true };
    case "working":
      return { ...pill("working", "运行中", "text-wb-fg-3", "bg-wb-fg-3"), pulse: true };
    case "failed":
      return attention.unread ? pill("failed", "失败", "text-wb-danger", "bg-wb-danger") : null;
    case "done":
      return attention.unread ? pill("done", "已完成", "text-wb-ok", "bg-wb-ok") : null;
    case "new":
    case "idle":
      return null;
  }
}

function pill(tone: AttentionTone, label: string, textClass: string, dotClass: string): AttentionPillView {
  return { tone, label, textClass, dotClass, pulse: false };
}

/** 等着你：在等输入，或者停下来了你还没看。 */
export function needsYou(attention: Attention | undefined): boolean {
  if (!attention) return false;
  if (attention.state === "needs-input") return true;
  return attention.unread && (attention.state === "done" || attention.state === "failed");
}

/** 越大越要先看：待批准 > 待回答 > 失败 > 完成 > 运行中 > 其他。 */
export function attentionRank(attention: Attention | undefined): number {
  switch (attentionPill(attention)?.tone) {
    case "approval":
      return 6;
    case "input":
      return 5;
    case "failed":
      return 4;
    case "done":
      return 3;
    case "working":
      return 2;
    default:
      return 0;
  }
}

/** 一组会话里最要紧的那个药丸。项目行用。 */
export function strongestPill(items: readonly (Attention | undefined)[]): AttentionPillView | null {
  let best: Attention | undefined;
  for (const item of items) {
    if (attentionRank(item) > attentionRank(best)) best = item;
  }
  return attentionPill(best);
}

export type BoardColumn = "needs-you" | "working" | "done" | "idle";

export const BOARD_COLUMNS: readonly BoardColumn[] = ["needs-you", "working", "done", "idle"];

/**
 * 看板的列。失败和在等输入的进「要你处理」；看过的完成和失败退到「空闲」。
 * 照 orca `src/renderer/src/components/dashboard/dashboard-card-bucket.ts`、`shared/dashboard-snapshot.ts`。
 */
export function boardColumn(attention: Attention): BoardColumn {
  switch (attention.state) {
    case "needs-input":
      return "needs-you";
    case "failed":
      return attention.unread ? "needs-you" : "idle";
    case "starting":
    case "working":
      return "working";
    case "done":
      return attention.unread ? "done" : "idle";
    case "new":
    case "idle":
      return "idle";
  }
}

export interface QueueItem {
  id: string;
  attention: Attention;
}

/** 注意力队列：等着你的，最要紧的在前，同样要紧的等得最久的在前。 */
export function attentionQueue<T extends QueueItem>(items: readonly T[]): T[] {
  return items
    .filter((item) => needsYou(item.attention))
    .sort(
      (a, b) =>
        attentionRank(b.attention) - attentionRank(a.attention) ||
        a.attention.updatedAt - b.attention.updatedAt,
    );
}

/** 队列里当前这个之后的下一个，到头了绕回来。当前不在队列里时取第一个。 */
export function nextInQueue<T extends QueueItem>(queue: readonly T[], currentId: string | null): T | null {
  if (queue.length === 0) return null;
  const index = queue.findIndex((item) => item.id === currentId);
  if (index < 0) return queue[0];
  if (queue.length === 1) return null;
  return queue[(index + 1) % queue.length];
}
