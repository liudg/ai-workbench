/** 本地分支名。与后端 `valid_branch_name` 同一套短引用限制。 */
export function branchNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "请输入分支名";
  if (!validBranchName(trimmed)) return "分支名无效";
  return null;
}

export function branchSearchPlaceholder(projectName: string): string {
  return `搜索${projectName.trim()}分支`;
}

/** 没有稳定的数量时不显示副文案。0 也省略。 */
export function uncommittedFileLabel(count: number | null | undefined): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  return `未提交：${Math.floor(count)} 个文件`;
}

export function filterBranchNames(branches: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...branches];
  return branches.filter((branch) => branch.toLowerCase().includes(needle));
}

/** 分离头指针没有分支名时，芯片显示 HEAD，不编造名字。 */
export function gitBranchChipLabel(branch: string | null | undefined): string {
  const name = branch?.trim() ?? "";
  if (!name || name === "HEAD") return "HEAD";
  return name;
}

function validBranchName(name: string): boolean {
  if (!name || name.toLowerCase() === "head" || name === "@") return false;
  if (
    name.startsWith("-") ||
    name.startsWith(".") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.includes("//") ||
    name.includes("..") ||
    name.includes("@{") ||
    name.includes("\\")
  ) {
    return false;
  }
  if ([...name].some((ch) => isForbiddenBranchChar(ch))) return false;
  return name.split("/").every((part) => {
    return (
      part.length > 0 &&
      !part.startsWith(".") &&
      !part.endsWith(".") &&
      !part.endsWith(".lock") &&
      part.length <= 255
    );
  });
}

function isForbiddenBranchChar(ch: string): boolean {
  if (ch === " " || ch === "~" || ch === "^" || ch === ":" || ch === "?" || ch === "*" || ch === "[") {
    return true;
  }
  const code = ch.charCodeAt(0);
  return code < 32 || code === 127;
}
