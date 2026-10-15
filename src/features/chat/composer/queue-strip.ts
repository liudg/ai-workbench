import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";

export interface QueueStripItem {
  id: string;
  text: string;
  images?: string[];
}

export interface QueueMenuEntry {
  id: "edit" | "side-chat" | "close";
  label: string;
}

/**
 * 工作台没有侧边聊天，调用处传 false。
 * 多条时操作作用在当前条（默认队首），点数字切到下一条。
 * TODO(codex-parity): 对照本机 Codex 桌面核对图标、行高，以及多条是逐行还是这一条 chrome。
 */
export function queueMenuItems(sideChat: boolean): QueueMenuEntry[] {
  const items: QueueMenuEntry[] = [{ id: "edit", label: DESKTOP_ZH.queueEdit }];
  if (sideChat) items.push({ id: "side-chat", label: DESKTOP_ZH.queueSideChat });
  items.push({ id: "close", label: DESKTOP_ZH.queueClose });
  return items;
}

export function queueStripVisible(input: { supportsQueue: boolean; count: number }): boolean {
  return input.supportsQueue && input.count > 0;
}

export function clampQueueIndex(count: number, index: number): number {
  if (count <= 0) return 0;
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

export function nextQueueIndex(count: number, index: number): number {
  if (count <= 1) return 0;
  return (clampQueueIndex(count, index) + 1) % count;
}

export function focusedQueueItem<T>(items: readonly T[], index: number): T | null {
  if (items.length === 0) return null;
  return items[clampQueueIndex(items.length, index)] ?? null;
}

export function queuePreviewText(item: { text: string; images?: string[] }): string {
  const text = item.text.replace(/\s+/g, " ").trim();
  if (text) return text;
  const image = item.images?.[0];
  if (!image) return "";
  const name = image.split(/[/\\]/).pop() || image;
  const extra = (item.images?.length ?? 0) - 1;
  return extra > 0 ? `${name} +${extra}` : name;
}

export type QueueStripIntent =
  | { type: "steer" | "remove" | "edit"; id: string }
  | { type: "close" };

export function queueStripIntent(
  action: "steer" | "remove" | "edit" | "close",
  item: { id: string } | null,
): QueueStripIntent | null {
  if (action === "close") return { type: "close" };
  if (!item) return null;
  return { type: action, id: item.id };
}
