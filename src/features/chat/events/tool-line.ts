export type ToolGlyph = "command" | "image" | "tool";

/**
 * 折叠行只留摘要的第一行。空摘要退回适配器写入的 name。
 * 不按某一种 CLI 的协议字段改写文案。
 */
export function toolLineText(name: string, summary: string): string {
  const line = summary
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line) return line;
  const fallback = name.trim();
  return fallback || "工具调用";
}

/** 图标只看规范化后的 name / 图片数量。 */
export function toolGlyph(name: string, imageCount: number): ToolGlyph {
  if (imageCount > 0) return "image";
  if (name === "command") return "command";
  return "tool";
}
