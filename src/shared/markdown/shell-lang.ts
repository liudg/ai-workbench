/** 代码块标注的语言是终端命令时，聊天里给它「运行」按钮。 */
const SHELL_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "fish",
  "console",
  "terminal",
  "powershell",
  "pwsh",
  "ps1",
  "cmd",
  "bat",
]);

export function isShellLang(lang: string): boolean {
  const name = lang.trim().split(/[\s{]/, 1)[0]?.toLowerCase() ?? "";
  return SHELL_LANGS.has(name);
}
