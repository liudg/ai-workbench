// Marked 负责块结构；这里转换为回答组件使用的节点。

import { Lexer, type Token, type Tokens } from "marked";
import type { AnswerBlock, Inline } from "./ast.ts";
import { inlinePlain, parseInlines } from "./inline.ts";

export function parseBlocks(input: string, promoteHeading = true): AnswerBlock[] {
  return convertBlocks(Lexer.lex(input, { gfm: true }), promoteHeading);
}

function convertBlocks(tokens: Token[], promoteHeading: boolean): AnswerBlock[] {
  return tokens.flatMap((token): AnswerBlock[] => {
    switch (token.type) {
      case "space":
      case "def":
        return [];
      case "heading":
        return [{ type: "heading", level: Math.min(token.depth, 3) as 1 | 2 | 3, inlines: parseInlines(token.text) }];
      case "hr":
        return [{ type: "rule" }];
      case "code":
        return [{ type: "code", lang: token.lang ?? "", text: token.text, meta: null }];
      case "blockquote":
        return [{ type: "quote", inlines: parseInlines(token.text) }];
      case "list":
        return [convertList(token as Tokens.List)];
      case "table": {
        const table = token as Tokens.Table;
        return [{
          type: "table",
          header: table.header.map((cell) => parseInlines(cell.text)),
          aligns: table.align.map((align) => align ?? "left"),
          rows: table.rows.map((row) => row.map((cell) => parseInlines(cell.text))),
          meta: null,
        }];
      }
      case "paragraph":
      case "text":
        return [paragraph(token.text, promoteHeading)];
      case "html":
        return [{ type: "paragraph", inlines: [{ type: "text", text: token.text }] }];
      default:
        throw new Error(`无法转换 Markdown 块：${token.type}`);
    }
  });
}

function convertList(token: Tokens.List): AnswerBlock {
  return {
    type: "list",
    ordered: token.ordered,
    start: token.start === "" ? undefined : token.start,
    loose: token.loose,
    items: token.items.map(convertListItem),
    meta: null,
  };
}

function convertListItem(item: Tokens.ListItem): AnswerBlock[] {
  const first = item.tokens[0];
  if (first?.type !== "checkbox") return convertBlocks(item.tokens, false);
  const blocks = convertBlocks(item.tokens.slice(1), false);
  const marker: Inline = { type: "text", text: first.raw };
  if (blocks[0]?.type === "paragraph") {
    blocks[0].inlines.unshift(marker);
  } else {
    blocks.unshift({ type: "paragraph", inlines: [marker] });
  }
  return blocks;
}

function paragraph(text: string, promoteHeading: boolean): AnswerBlock {
  const inlines = parseInlines(text);
  const content = inlines.filter(
    (node) => node.type !== "break" && !(node.type === "text" && node.text.trim() === ""),
  );
  if (content.length === 1 && content[0].type === "image") {
    return { type: "image", alt: content[0].alt, source: content[0].source };
  }
  if (promoteHeading && content.length === 1 && content[0].type === "strong" && isShortTitle(content[0].inlines)) {
    return { type: "heading", level: 2, inlines: content[0].inlines };
  }
  return { type: "paragraph", inlines };
}

function isShortTitle(inlines: Inline[]): boolean {
  const text = inlinePlain(inlines).trim();
  return text.length > 0 && text.length <= 40 && !/[。！？!?\n]/.test(text);
}
