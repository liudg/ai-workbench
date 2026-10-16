import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";

export type GitProbe = "checking" | "yes" | "no";

/** 把当前差异收成一段可以 `git apply` 的补丁。空补丁返回空串。 */
export function patchFromFiles(files: readonly { diff: string }[]): string {
  return files
    .map((file) => file.diff.replace(/^\uFEFF/, "").trim())
    .filter((diff) => diff.length > 0)
    .join("\n");
}

/**
 * Codex 桌面「复制 git apply 命令」：把补丁放进 heredoc。
 * 补丁里若已有结束符，就加长标记，避免命令被截断。
 */
export function gitApplyCommand(patch: string): string | null {
  const trimmed = patch.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return null;
  const body = trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  const lines = new Set(body.split("\n"));
  let marker = "EOF";
  while (lines.has(marker)) marker = `${marker}_`;
  return `git apply <<'${marker}'\n${body}${marker}\n`;
}

/** 非 git 仓库，或没有可应用的补丁时，菜单项保持禁用并给出原因。 */
export function copyApplyState(input: {
  git: GitProbe;
  gitReason: string;
  patch: string;
}): { enabled: boolean; reason: string; command: string | null } {
  if (input.git === "checking") {
    return {
      enabled: false,
      reason: input.gitReason || DESKTOP_ZH.diffGitChecking,
      command: null,
    };
  }
  if (input.git !== "yes") {
    return {
      enabled: false,
      reason: input.gitReason || DESKTOP_ZH.diffNotGit,
      command: null,
    };
  }
  const command = gitApplyCommand(input.patch);
  if (!command) {
    return { enabled: false, reason: DESKTOP_ZH.diffCopyUnavailable, command: null };
  }
  return { enabled: true, reason: "", command };
}

