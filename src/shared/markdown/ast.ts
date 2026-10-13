// 回答 Markdown 的块和行内节点。解析器只产出这棵树。

import type { ImageSource } from "./markdown-images.ts";

export type Align = "left" | "center" | "right";

export type CollapseKind = "directory" | "files" | "table";

export type CollapseMeta = {
  kind: CollapseKind;
  count: number;
  detail: string;
  fallback: string;
};

export type Inline =
  | { type: "text"; text: string }
  | { type: "break" }
  | { type: "strong"; inlines: Inline[] }
  | { type: "em"; inlines: Inline[] }
  | { type: "code"; text: string; display?: string; title?: string }
  | { type: "link"; inlines: Inline[]; href: string; title?: string }
  | { type: "path"; display: string; full: string }
  | { type: "image"; alt: string; source: ImageSource };

export type AnswerBlock =
  | { type: "heading"; level: 1 | 2 | 3; inlines: Inline[] }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][]; meta: CollapseMeta | null }
  | {
      type: "table";
      header: Inline[][];
      aligns: Align[];
      rows: Inline[][][];
      meta: CollapseMeta | null;
    }
  | { type: "code"; lang: string; text: string; meta: CollapseMeta | null }
  | { type: "quote"; inlines: Inline[] }
  | { type: "rule" }
  | { type: "image"; alt: string; source: ImageSource }
  | { type: "section"; title: Inline[]; meta: CollapseMeta; body: AnswerBlock };
