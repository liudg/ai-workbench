import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function displayPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  if (path.startsWith("\\\\?\\")) return path.slice("\\\\?\\".length);
  return path;
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/** 悬停时显示在消息下方，例如「星期五 18:32」。 */
export function formatMessageTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]} ${hh}:${mm}`;
}

/** 这次打开只读：另一个进程占着会话线程写锁。 */
export function isReadOnlyOpen(events: { kind: string }[] | undefined): boolean {
  return events?.some((event) => event.kind === "read-only") ?? false;
}

/** 从事件日志推导当前待回答的提问（最后一个未被 resolved 覆盖的 prompt） */
export function pendingPrompt(
  events: { kind: string; prompt_id?: string }[],
): string | null {
  const resolved = new Set(
    events
      .filter((e) => e.kind === "prompt-resolved")
      .map((e) => e.prompt_id as string),
  );
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "prompt" && e.prompt_id && !resolved.has(e.prompt_id)) {
      return e.prompt_id;
    }
  }
  return null;
}
