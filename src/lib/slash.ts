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
  if (name === "mcp") {
    if (!rest) return "已连接的 MCP 服务器会列在这里。用法：/mcp verbose";
    if (rest === "verbose") return "verbose 会显示 STDIO 或 Streamable HTTP、认证状态和全部工具。";
    return "用法：/mcp 或 /mcp verbose";
  }
  if (name === "goal") {
    if (!rest) return "当前没有任务目标。用法：/goal <目标>";
    if (rest === "clear") return "将清除任务目标。";
    if (rest === "pause") return "将暂停当前任务目标。";
    if (rest === "resume") return "将继续当前任务目标。";
    if (rest === "edit") return "用法：/goal edit <新目标>。目标不能为空，最多 4000 个字符。";
    return `任务目标将设为：${rest}`;
  }
  if (name === "hooks") return "将列出当前目录发现的钩子，以及是否已信任。";
  if (name === "worktree") {
    if (!rest || rest === "status") return "将显示工作树根目录和这个仓库的工作树。";
    if (rest === "new" || rest === "create") return "将在工作树根目录新建一个 detached HEAD。";
    return "用法：/worktree 或 /worktree new";
  }
  const known = commands.find((cmd) => cmd.name === `/${name}`);
  if (known) {
    return `${known.name}：${known.hint}。浏览器预览不会启动 Codex。`;
  }
  return `/${name} 是 Codex 终端里的命令，工作台不会把它当成给模型的提示。输入 /help 查看这里能执行的命令。`;
}
