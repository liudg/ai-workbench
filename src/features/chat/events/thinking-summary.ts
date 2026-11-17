const SUMMARY_LIMIT = 120;
const PLACEHOLDERS = new Set(["思考中…", "思考中..."]);

/** 整段思考只有协议占位词，没有实际推理内容。 */
export function isPlaceholderThinking(text: string): boolean {
  return PLACEHOLDERS.has(text.trim());
}

/**
 * 提取思考收起态的一行摘要：跳过围栏代码块与分隔线，取第一条非空正文行并剥掉 Markdown 标记。
 * 占位词（如「思考中…」）不重复显示在标题旁。
 */
export function thinkingSummary(text: string): string {
  let fence: { char: string; len: number } | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (fence) {
      if (closesFence(trimmed, fence)) fence = null;
      continue;
    }
    if (!trimmed) continue;
    const opened = opensFence(trimmed);
    if (opened) {
      fence = opened;
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed)) continue;
    const cleaned = stripInlineMarkdown(stripBlockPrefix(trimmed));
    if (!cleaned || PLACEHOLDERS.has(cleaned)) continue;
    return clipCodePoints(cleaned, SUMMARY_LIMIT);
  }
  return "";
}

function opensFence(trimmed: string): { char: string; len: number } | null {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
  if (!match) return null;
  const [, marker, rest] = match;
  // CommonMark：反引号围栏的语言标识里不能再出现反引号，否则是同一行内的行内代码（如 ```foo```）。
  if (marker[0] === "`" && rest.includes("`")) return null;
  return { char: marker[0], len: marker.length };
}

function closesFence(trimmed: string, fence: { char: string; len: number }): boolean {
  const match = /^(`{3,}|~{3,})\s*$/.exec(trimmed);
  return Boolean(match && match[1][0] === fence.char && match[1].length >= fence.len);
}

function stripBlockPrefix(line: string): string {
  let current = line.trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const next = current
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(?:>\s*)+/, "")
      .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX/]\]\s+)?/, "")
      .trim();
    if (next === current) break;
    current = next;
  }
  return current;
}

function stripInlineMarkdown(line: string): string {
  const codes: string[] = [];
  const shielded = line.replace(/(`+)([^`]+?)\1/g, (_, _ticks: string, code: string) => {
    const slot = `\u0000${codes.length}\u0000`;
    codes.push(code);
    return slot;
  });
  const stripped = shielded
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<![\p{L}\p{N}_])__(.+?)__(?![\p{L}\p{N}_.])/gu, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/(?<![A-Za-z0-9*])\*([^*\n]+?)\*(?![A-Za-z0-9*])/g, "$1");
  const restored = stripped.replace(/\u0000(\d+)\u0000/g, (_, index: string) => codes[Number(index)] ?? "");
  return restored.replace(/\s+/g, " ").trim();
}

function clipCodePoints(text: string, limit: number): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return `${chars.slice(0, limit - 1).join("").trimEnd()}…`;
}
