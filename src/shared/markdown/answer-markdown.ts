// 助手回答的阅读排版。只影响展示，不改模型原文。
// 组合块解析与收起规则。

import type { Align, AnswerBlock, CollapseKind, CollapseMeta, Inline } from "./ast.ts";
import { parseBlocks } from "./blocks.ts";
import { attachSections } from "./collapse.ts";

export type { Align, AnswerBlock, CollapseKind, CollapseMeta, Inline };
export { inlinePlain } from "./inline.ts";
export { shortenLocalPath } from "./paths.ts";

export function parseAnswer(input: string): AnswerBlock[] {
  return attachSections(parseBlocks(input));
}
