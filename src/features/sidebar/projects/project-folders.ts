/** 编辑项目时的源文件夹。旧数据没有 folders 时，用项目路径补上。 */

export function projectFolders(project: {
  path?: string | null;
  folders?: readonly string[] | null;
}): string[] {
  const listed = (project.folders ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  if (listed.length > 0) return listed;
  const path = project.path?.trim() ?? "";
  return path ? [path] : [];
}

/** 比较草稿里的目录。Windows 路径忽略大小写和末尾分隔符。 */
export function sameFolder(left: string, right: string): boolean {
  return folderKey(left) === folderKey(right);
}

function folderKey(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const unified = trimmed.replaceAll("\\", "/");
  const windows = /^[a-zA-Z]:/.test(unified) || unified.startsWith("//");
  return windows ? unified.toLowerCase() : unified;
}
