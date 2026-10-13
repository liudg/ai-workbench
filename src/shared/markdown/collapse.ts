// 目录清单、代码入口和大表的收起信息。不改块的原文。

import type { AnswerBlock, CollapseKind, CollapseMeta, Inline } from "./ast.ts";
import { inlinePlain } from "./inline.ts";
import {
  CODE_FILE,
  CODE_FILE_IN,
  isAbsoluteLocal,
  isLocalPath,
  pathSegments,
} from "./paths.ts";

const TABLE_MIN_ROWS = 6;
const FILE_LIST_MIN = 3;
const DIR_LIST_MIN = 6;
const DIR_CODE_MIN = 8;

export function attachSections(blocks: AnswerBlock[]): AnswerBlock[] {
  const tagged = blocks.map(applyMeta);
  const out: AnswerBlock[] = [];
  for (let i = 0; i < tagged.length; i += 1) {
    const block = tagged[i];
    const next = tagged[i + 1];
    if (block.type === "heading" && next && collapseOf(next)) {
      out.push({
        type: "section",
        title: block.inlines,
        meta: collapseOf(next) as CollapseMeta,
        body: clearMeta(next),
      });
      i += 1;
      continue;
    }
    out.push(block);
  }
  return out;
}

function applyMeta(block: AnswerBlock): AnswerBlock {
  const meta = collapseMeta(block);
  if (!meta) return block;
  if (block.type === "list" || block.type === "table" || block.type === "code") {
    return { ...block, meta };
  }
  return block;
}

function clearMeta(block: AnswerBlock): AnswerBlock {
  if (block.type === "list" || block.type === "table" || block.type === "code") {
    return { ...block, meta: null };
  }
  return block;
}

function collapseOf(block: AnswerBlock): CollapseMeta | null {
  if (block.type === "list" || block.type === "table" || block.type === "code") return block.meta;
  return null;
}

function collapseMeta(block: AnswerBlock): CollapseMeta | null {
  if (block.type === "table" && block.rows.length >= TABLE_MIN_ROWS) {
    return meta("table", block.rows.length, `${block.rows.length} 行`, "表格");
  }
  if (block.type === "list" && isFileList(block.items)) {
    return meta("files", block.items.length, `${block.items.length} 个文件`, "代码入口");
  }
  if (block.type === "list" && isDirectoryList(block.items)) {
    return meta("directory", block.items.length, `${block.items.length} 项`, "目录");
  }
  if (block.type === "code" && isDirectoryCode(block.text)) {
    const count = block.text.split("\n").filter((line) => line.trim()).length;
    return meta("directory", count, `${count} 项`, "目录");
  }
  return null;
}

function meta(kind: CollapseKind, count: number, detail: string, fallback: string): CollapseMeta {
  return { kind, count, detail, fallback };
}

function isFileList(items: Inline[][]): boolean {
  if (items.length < FILE_LIST_MIN) return false;
  const hits = items.filter(isFileItem).length;
  return hits / items.length >= 0.75;
}

function isFileItem(inlines: Inline[]): boolean {
  const plain = inlinePlain(inlines).trim();
  const hrefs = collectHrefs(inlines);
  const first = firstContent(inlines);
  const leading =
    (first?.type === "link" &&
      (startsWithCodeFile(inlinePlain(first.inlines)) ||
        hrefs.some((href) => CODE_FILE_IN.test(href)))) ||
    (first?.type === "code" && startsWithCodeFile(first.text)) ||
    (first?.type === "path" && CODE_FILE_IN.test(first.full)) ||
    ((first?.type === "text" || first?.type === "strong") && startsWithCodeFile(plain));
  if (!leading) return false;
  const hasPath = hrefs.some((href) => isLocalPath(href)) || inlines.some((node) => node.type === "path");
  return hasPath || /[：:]/.test(plain);
}

function startsWithCodeFile(plain: string): boolean {
  const token = plain
    .trim()
    .replace(/^[`[]+/, "")
    .split(/[\s：:(]/)[0]
    ?.replace(/[\]`]+$/, "");
  return !!token && CODE_FILE.test(token);
}

function isDirectoryList(items: Inline[][]): boolean {
  if (items.length < DIR_LIST_MIN) return false;
  const hits = items.filter(isDirectoryItem).length;
  return hits / items.length >= 0.8;
}

function isDirectoryItem(inlines: Inline[]): boolean {
  const plain = inlinePlain(inlines).trim();
  if (!plain || plain.length > 180) return false;
  const head = plain.split(/[：:]/)[0]?.trim().replace(/^`+|`+$/g, "") ?? "";
  if (!head || head.length < plain.length * 0.6) return false;
  if (/\s/.test(head) && !isAbsoluteLocal(head)) return false;
  return isPathLike(head);
}

function isDirectoryCode(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < DIR_CODE_MIN) return false;
  const hits = lines.filter(isListingLine).length;
  return hits / lines.length >= 0.7;
}

function isListingLine(line: string): boolean {
  const trimmed = line.trim();
  const structural = /[│├└┤┬┼─]/.test(trimmed);
  const payload = trimmed.replace(/^[-|\s`\\+─│├└┤┬┼]+/, "").trim();
  if (structural && payload.length > 0) return true;
  if (!payload) return structural;
  if (isPathLike(payload) || isAbsoluteLocal(payload)) return true;
  if (/\/$/.test(payload)) return true;
  return CODE_FILE.test(payload) && !/\s/.test(payload);
}

function isPathLike(text: string): boolean {
  if (isAbsoluteLocal(text)) return pathSegments(text).length >= 2;
  return /^(?:[\w.+@-]+[\\/]){2,}[\w.+@-]+\/?$/.test(text);
}

function firstContent(inlines: Inline[]): Inline | undefined {
  return inlines.find((node) => node.type !== "break" && !(node.type === "text" && node.text.trim() === ""));
}

function collectHrefs(inlines: Inline[]): string[] {
  const hrefs: string[] = [];
  for (const node of inlines) {
    if (node.type === "link") {
      hrefs.push(node.href);
      hrefs.push(...collectHrefs(node.inlines));
    } else if (node.type === "strong" || node.type === "em") {
      hrefs.push(...collectHrefs(node.inlines));
    }
  }
  return hrefs;
}
