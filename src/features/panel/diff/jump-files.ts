export interface JumpFile {
  path: string;
}

/** 弹出层一行：文件名，后面跟灰色的父目录。 */
export function jumpFileParts(path: string): { name: string; dir: string } {
  const norm = path.replace(/\\/g, "/").replace(/\/+$/u, "");
  const slash = norm.lastIndexOf("/");
  if (slash < 0) return { name: norm, dir: "" };
  return { name: norm.slice(slash + 1), dir: norm.slice(0, slash) };
}

/** 跳转弹窗只列当前范围正在显示的文件，不另取会话事件里的文件。 */
export function visibleJumpFiles<T extends JumpFile>(shown: readonly T[]): T[] {
  return shown.slice();
}

/** 只能跳到这份正在显示的列表里的路径。 */
export function jumpSelection(shown: readonly JumpFile[], path: string): string | null {
  return shown.some((file) => file.path === path) ? path : null;
}

/** 只筛当前范围正在显示的文件，不扫工作区。 */
export function filterJumpFiles<T extends JumpFile>(files: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files.slice();
  return files.filter((file) => {
    const parts = jumpFileParts(file.path);
    const haystack = `${parts.name}\n${parts.dir}\n${file.path}`.toLowerCase();
    return haystack.includes(needle);
  });
}
