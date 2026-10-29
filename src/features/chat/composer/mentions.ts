/** 光标所在的 `@` 片段。刚输入 `@` 时查询为空字符串。 */
export function atToken(text: string, caret: number): string | null {
  const upto = text.slice(0, Math.max(0, caret));
  const match = upto.match(/(^|[\s\n])@([^@\s]*)$/);
  return match ? match[2] : null;
}

/** Codex TUI：路径含空白且本身没有引号时才加引号。 */
export function quoteMentionPath(path: string): string {
  if (/\s/.test(path) && !path.includes('"')) return `"${path}"`;
  return path;
}

/**
 * 文件框关掉之后用哪份文本。
 * 对话框期间没有新的渲染时，状态还是打开前的原文，这时用已经算好的、去掉 `@` 的文本。
 */
export function mentionPickText(started: string, latest: string, cleared: string): string {
  return latest === started ? cleared : latest;
}

/** 文件框关掉之后，用这时的光标插入。光标不在了就退回打开文件框之前的位置。 */
export function caretAfterMentionPick(fallback: number, selection: number | null, length: number): number {
  const raw = selection == null ? fallback : selection;
  return Math.min(Math.max(raw, 0), Math.max(length, 0));
}

export function clearAtToken(text: string, caret: number): { text: string; caret: number } {
  const upto = text.slice(0, Math.max(0, caret));
  const match = upto.match(/(^|[\s\n])@([^@\s]*)$/);
  if (!match || match.index == null) return { text, caret };
  const start = match.index + match[1].length;
  return { text: text.slice(0, start) + text.slice(caret), caret: start };
}

/** 用选中的路径换掉光标处的 `@查询`，并在末尾留一个空格。 */
export function insertMention(
  text: string,
  caret: number,
  paths: readonly string[],
): { text: string; caret: number } {
  const cleaned = paths.map((path) => path.trim()).filter(Boolean);
  if (cleaned.length === 0) return clearAtToken(text, caret);
  const insertion = `${cleaned.map(quoteMentionPath).join(" ")} `;
  const upto = text.slice(0, Math.max(0, caret));
  const match = upto.match(/(^|[\s\n])@([^@\s]*)$/);
  const start = match && match.index != null ? match.index + match[1].length : caret;
  const next = text.slice(0, start) + insertion + text.slice(caret);
  return { text: next, caret: start + insertion.length };
}

export interface MentionFile {
  path: string;
  name: string;
  directory: string;
}

/** 文件名命中排在路径命中前面。查询本身已由工作区筛选做过，这里只排序和截断。 */
export function mentionFiles(paths: readonly string[], query: string, limit = 30): MentionFile[] {
  const needle = query.trim().toLowerCase();
  const rows = paths.map((path) => {
    const normalized = path.replaceAll("\\", "/");
    const name = normalized.split("/").pop() || normalized;
    const directory = normalized.slice(0, Math.max(0, normalized.length - name.length)).replace(/\/$/, "");
    const nameIndex = needle ? name.toLowerCase().indexOf(needle) : -1;
    return { path: normalized, name, directory, nameIndex };
  });
  rows.sort((a, b) => {
    const aName = a.nameIndex >= 0 ? 0 : 1;
    const bName = b.nameIndex >= 0 ? 0 : 1;
    if (aName !== bName) return aName - bName;
    if (a.nameIndex !== b.nameIndex) return a.nameIndex - b.nameIndex;
    return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
  });
  return rows.slice(0, limit).map(({ path, name, directory }) => ({ path, name, directory }));
}

export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const needle = query.trim();
  if (!needle) return [{ text, match: false }];
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return [{ text, match: false }];
  return [
    { text: text.slice(0, index), match: false },
    { text: text.slice(index, index + needle.length), match: true },
    { text: text.slice(index + needle.length), match: false },
  ].filter((part) => part.text.length > 0);
}

export const MENTION_ADD_ORDER = ["files", "goal", "plan"] as const;

export type MentionAddId = (typeof MENTION_ADD_ORDER)[number];

export type MentionSupport = "ready" | "loading" | "unsupported";

export function mentionAddEnabled(id: MentionAddId, goal: MentionSupport, plan: MentionSupport): boolean {
  if (id === "files") return true;
  return (id === "goal" ? goal : plan) === "ready";
}

/** `@` 添加菜单里要列出的项。Agent 不支持的不列；能力还没回来时先列出、不能选。 */
export function mentionAddItems(goal: MentionSupport, plan: MentionSupport): MentionAddId[] {
  return MENTION_ADD_ORDER.filter((id) => id === "files" || (id === "goal" ? goal : plan) !== "unsupported");
}

export function mentionSupport(known: boolean, supported: boolean): MentionSupport {
  if (!known) return "loading";
  return supported ? "ready" : "unsupported";
}
