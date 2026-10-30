// 输入框里引用的文件：框里只写短的 `@文件名`，发送时换回完整路径。
// 输入框里技能和文件引用画成标签，其余照原文。

import { quoteMentionPath } from "./mentions.ts";

export interface FileRef {
  /** 框里显示的那段，带 `@`。 */
  label: string;
  path: string;
}

export type ComposerToken =
  | { kind: "text"; text: string }
  | { kind: "file"; text: string; path: string }
  | { kind: "skill"; text: string };

const AT_QUERY = /(^|[\s\n])@([^@\s]*)$/;

function segments(path: string): string[] {
  return path.replaceAll("\\", "/").split("/").filter(Boolean);
}

/** 文件名不撞就只用文件名；撞了往上补目录，补到能分开为止。 */
export function refLabel(path: string, refs: readonly FileRef[]): string {
  const same = refs.find((ref) => ref.path === path);
  if (same) return same.label;
  const parts = segments(path);
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const label = quoteLabel(`@${parts.slice(-depth).join("/")}`);
    if (!refs.some((ref) => ref.label === label)) return label;
  }
  return quoteLabel(`@${parts.join("/")}`);
}

/** 含空白的名字整段加引号，不然发送时找不回整段。 */
function quoteLabel(label: string): string {
  return /\s/.test(label) ? `@"${label.slice(1)}"` : label;
}

/** 用选中的文件换掉光标处的 `@查询`，末尾留一个空格。 */
export function insertFileRefs(
  text: string,
  caret: number,
  paths: readonly string[],
  refs: readonly FileRef[],
): { text: string; caret: number; refs: FileRef[] } {
  const next = [...refs];
  const labels: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    const label = refLabel(path, next);
    if (!next.some((ref) => ref.label === label)) next.push({ label, path });
    labels.push(label);
  }
  const upto = text.slice(0, Math.max(0, caret));
  const match = upto.match(AT_QUERY);
  const start = match && match.index != null ? match.index + match[1].length : caret;
  const insertion = labels.length > 0 ? `${labels.join(" ")} ` : "";
  return {
    text: text.slice(0, start) + insertion + text.slice(caret),
    caret: start + insertion.length,
    refs: next,
  };
}

/** `label` 在 `index` 处，且前后都是边界。 */
function standsAlone(text: string, index: number, label: string): boolean {
  const before = index === 0 ? "" : text[index - 1];
  const after = text[index + label.length] ?? "";
  return (before === "" || /\s/.test(before)) && (after === "" || /[\s,.;:!?，。；：！？)）]/.test(after));
}

function findLabel(text: string, label: string, from: number): number {
  let index = text.indexOf(label, from);
  while (index >= 0 && !standsAlone(text, index, label)) index = text.indexOf(label, index + 1);
  return index;
}

/** 框里还在的引用。删掉的不再带着。 */
export function liveFileRefs(text: string, refs: readonly FileRef[]): FileRef[] {
  return refs.filter((ref) => findLabel(text, ref.label, 0) >= 0);
}

/** 发出去的正文：`@文件名` 换回完整路径。 */
export function expandFileRefs(text: string, refs: readonly FileRef[]): string {
  if (refs.length === 0) return text;
  return composerTokens(text, refs, [])
    .map((token) => (token.kind === "file" ? quoteMentionPath(token.path) : token.text))
    .join("");
}

/** 切成普通文字、文件引用、技能三种。技能只认目录里有的 `$名字`。 */
export function composerTokens(
  text: string,
  refs: readonly FileRef[],
  skills: readonly string[],
): ComposerToken[] {
  const hits: { start: number; end: number; token: ComposerToken }[] = [];
  for (const ref of refs) {
    let index = findLabel(text, ref.label, 0);
    while (index >= 0) {
      hits.push({ start: index, end: index + ref.label.length, token: { kind: "file", text: ref.label, path: ref.path } });
      index = findLabel(text, ref.label, index + ref.label.length);
    }
  }
  if (skills.length > 0) {
    const known = new Set(skills.map((skill) => skill.replace(/^\$/, "").toLowerCase()));
    for (const match of text.matchAll(/(^|\s)(\$[A-Za-z0-9_.:-]+)/g)) {
      const word = match[2];
      if (!known.has(word.slice(1).toLowerCase())) continue;
      const start = (match.index ?? 0) + match[1].length;
      hits.push({ start, end: start + word.length, token: { kind: "skill", text: word } });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const tokens: ComposerToken[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) tokens.push({ kind: "text", text: text.slice(cursor, hit.start) });
    tokens.push(hit.token);
    cursor = hit.end;
  }
  if (cursor < text.length) tokens.push({ kind: "text", text: text.slice(cursor) });
  return tokens;
}
