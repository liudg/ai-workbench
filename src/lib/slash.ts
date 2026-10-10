import type { SlashCommand } from "@/types";

/** 从当前 Agent 的命令表里过滤。命令表来自后端 profile / catalog，不是全局 Codex 表。 */
export function slashToken(text: string): string | null {
  if (!text.startsWith("/") || text.includes("\n")) return null;
  const token = text.trimStart().split(/\s/, 1)[0] ?? "";
  return token.startsWith("/") ? token.toLowerCase() : null;
}

export function filterSlash(commands: SlashCommand[], token: string): SlashCommand[] {
  return commands.filter((cmd) => cmd.name.startsWith(token));
}

export function slashPreview(commands: SlashCommand[], text: string): string {
  const body = text.trim().replace(/^\//, "");
  const [rawName, ...restParts] = body.split(/\s+/);
  const name = (rawName ?? "").toLowerCase();
  const rest = restParts.join(" ");
  if (name === "help" || name === "") {
    return commands.map((cmd) => `${cmd.name}  ${cmd.hint}`).join("\n");
  }
  if (name === "permissions" || name === "approvals") {
    if (!rest) return "用法：/permissions 完全访问 | 询问批准 | 只读";
    return `权限将设为${rest}。下一条消息起生效。`;
  }
  const known = commands.find((cmd) => cmd.name === `/${name}`);
  if (known) {
    return `${known.name}：${known.hint}。浏览器预览不会启动 Codex。`;
  }
  return `/${name} 是 Codex 终端里的命令，工作台不会把它当成给模型的提示。输入 /help 查看这里能执行的命令。`;
}
