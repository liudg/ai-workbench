export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function directoryOf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

/** 预览标题把路径写成「Scripts / GameUI / Module」。 */
export function pathCrumb(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).join(" / ");
}

/** 预览区左上角的盘符，例如 `F:`。没有盘符就不显示。 */
export function workspaceRootLabel(projectPath: string): string {
  const match = /^[A-Za-z]:/.exec(projectPath.trim());
  return match ? match[0] : "";
}

/**
 * 把路径收成相对项目根的形式。已经在根下就原样返回剩余部分。
 * 不在根下时保持规范化后的原路径，不另造一段。
 */
export function relativeToProject(path: string, root: string): string {
  const file = normalizePath(path.trim());
  const base = normalizePath(root.trim());
  if (!file || !base) return file;
  if (file.toLowerCase() === base.toLowerCase()) return "";
  const prefix = `${base}/`;
  if (!file.toLowerCase().startsWith(prefix.toLowerCase())) return file;
  return file.slice(prefix.length);
}

const ABSOLUTE_PATH =
  /[A-Za-z]:[\\/][^\s"'`<>|]*[^\s"'`<>|,;)]|\/(?:[^/\s"'`<>|]+\/)+[^\s"'`<>|,;)]+/g;

/** 摘要里的绝对路径换成相对项目根的路径。根以外的路径不动。 */
export function relativizeDisplayText(text: string, root: string): string {
  if (!text || !root.trim()) return text;
  return text.replace(ABSOLUTE_PATH, (match) => {
    const trimmed = match.replace(/[),.;:，。；：]+$/u, "");
    const suffix = match.slice(trimmed.length);
    const relative = relativeToProject(trimmed, root);
    const normalized = normalizePath(trimmed);
    if (!relative || relative.toLowerCase() === normalized.toLowerCase()) return match;
    return `${relative}${suffix}`;
  });
}

export function relativizeFiles<T extends { path: string }>(files: readonly T[], root: string): T[] {
  if (!root.trim()) return [...files];
  return files.map((file) => {
    const next = relativeToProject(file.path, root);
    const normalized = normalizePath(file.path);
    if (!next || next.toLowerCase() === normalized.toLowerCase()) return file;
    return { ...file, path: next };
  });
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
