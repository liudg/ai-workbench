import type { FileStatus } from "./diff-parse.ts";

export function fileStatusTone(status: FileStatus): "add" | "mod" | "del" | "neutral" {
  if (status === "A") return "add";
  if (status === "M") return "mod";
  if (status === "D") return "del";
  return "neutral";
}
