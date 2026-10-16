import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import type { FollowUpQueueMode } from "./follow-up-queue-mode.ts";

export interface QueueStripItem {
  id: string;
  text: string;
  images?: string[];
}

export interface QueueRowModel {
  id: string;
  position: number;
  preview: string;
}

export interface QueueMenuEntry {
  id: "edit" | "side-chat" | "queue-mode";
  label: string;
}

/**
 * 每一行是一条排队消息。位置从 1 开始。
 * 侧边聊天只在调用处声明真有该界面时出现。
 * `queue-mode` 切换 followUpQueueMode，不删除已经排着的消息。
 */
export function queueMenuItems(input: {
  canOpenSideChat: boolean;
  mode: FollowUpQueueMode;
}): QueueMenuEntry[] {
  const items: QueueMenuEntry[] = [{ id: "edit", label: DESKTOP_ZH.queueEdit }];
  if (input.canOpenSideChat) items.push({ id: "side-chat", label: DESKTOP_ZH.queueSideChat });
  items.push({
    id: "queue-mode",
    label: input.mode === "queue" ? DESKTOP_ZH.queueClose : DESKTOP_ZH.queueEnable,
  });
  return items;
}

export function queueStripVisible(input: { supportsQueue: boolean; count: number }): boolean {
  return input.supportsQueue && input.count > 0;
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

/**
 * 打开会话时拉到的队列，如果期间已经有实时推送换过这份列表，就不要再写回去。
 * 比较的是 store 里的数组引用。
 */
export function queueFetchStillCurrent(
  before: readonly unknown[] | undefined,
  current: readonly unknown[] | undefined,
): boolean {
  return before === current;
}

/** 一条消息一行。顺序就是队列顺序。 */
export function queueRows(items: readonly QueueStripItem[]): QueueRowModel[] {
  return items.map((item, index) => ({
    id: item.id,
    position: index + 1,
    preview: queuePreviewText(item),
  }));
}
