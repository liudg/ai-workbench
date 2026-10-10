export interface SlashCommand {
  name: string;
  hint: string;
  takesArgs?: boolean;
}

/** 工作台本地执行的 Codex 斜杠命令。终端专用命令不在此列表，发送后只提示、不进模型。 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/permissions", hint: "切换完全访问、询问批准或只读", takesArgs: true },
  { name: "/status", hint: "查看模型、线程、目录和权限" },
  { name: "/diff", hint: "查看 git diff --stat" },
  { name: "/review", hint: "请 Codex 审查当前工作区", takesArgs: true },
  { name: "/plan", hint: "只出计划，不改文件", takesArgs: true },
  { name: "/model", hint: "指定下一轮使用的模型", takesArgs: true },
  { name: "/compact", hint: "压缩当前线程的上下文" },
  { name: "/approve", hint: "说明如何处理自动审查拒绝" },
  { name: "/init", hint: "生成 AGENTS.md" },
  { name: "/new", hint: "下一条消息开启新线程" },
  { name: "/clear", hint: "放下当前线程，同 /new" },
  { name: "/stop", hint: "停止当前会话" },
  { name: "/help", hint: "列出工作台能执行的斜杠命令" },
];

export function slashToken(text: string): string | null {
  if (!text.startsWith("/") || text.includes("\n")) return null;
  const token = text.trimStart().split(/\s/, 1)[0] ?? "";
  return token.startsWith("/") ? token.toLowerCase() : null;
}

export function filterSlash(token: string): SlashCommand[] {
  return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(token));
}

export function slashPreview(text: string): string {
  const body = text.trim().replace(/^\//, "");
  const [rawName, ...restParts] = body.split(/\s+/);
  const name = (rawName ?? "").toLowerCase();
  const rest = restParts.join(" ");
  if (name === "help" || name === "") {
    return SLASH_COMMANDS.map((cmd) => `${cmd.name}  ${cmd.hint}`).join("\n");
  }
  if (name === "permissions" || name === "approvals") {
    if (!rest) return "用法：/permissions 完全访问 | 询问批准 | 只读";
    return `权限将设为${rest}。下一条消息起生效。`;
  }
  const known = SLASH_COMMANDS.find((cmd) => cmd.name === `/${name}`);
  if (known) {
    return `${known.name}：${known.hint}。浏览器预览不会启动 Codex。`;
  }
  return `/${name} 是 Codex 终端里的命令，工作台不会把它当成给模型的提示。输入 /help 查看这里能执行的命令。`;
}
