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
