import type { FileStatus } from "./diff-parse.ts";

export function fileStatusTone(status: FileStatus): "add" | "del" | "neutral" {
  if (status === "A" || status === "M") return "add";
  if (status === "D") return "del";
  return "neutral";
}
