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

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
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
