import type { FileStatus } from "../../changes-model/diff-parse.ts";

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function directoryOf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

export function fileStatusTone(status: FileStatus): "add" | "del" | "neutral" {
  if (status === "A" || status === "M") return "add";
  if (status === "D") return "del";
  return "neutral";
}

/** 预览区左上角的盘符，例如 `F:`。没有盘符就不显示。 */
export function workspaceRootLabel(projectPath: string): string {
  const match = /^[A-Za-z]:/.exec(projectPath.trim());
  return match ? match[0] : "";
}

export function normalizePath(path: string): string {
  const unix = path.replace(/\\/g, "/");
  const drive = /^[A-Za-z]:/.exec(unix)?.[0] ?? "";
  const rooted = unix.startsWith("/");
  const rest = drive ? unix.slice(drive.length) : unix;
  const stack: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  const body = stack.join("/");
  if (drive) return `${drive}/${body}`;
  if (rooted) return `/${body}`;
  return body;
}
