import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import {
  codeDisplayLines,
  parseAnswer,
  type Align,
  type AnswerBlock,
  type CollapseMeta,
  type Inline,
} from "./answer-markdown";
import { cn } from "@/lib/utils";
import { isFileHref } from "../changes/model";
import { usePreviewOptional } from "../changes/preview-context";
import { MessageImage } from "./MessageContent";

export function AssistantAnswer({ text }: { text: string }) {
  const blocks = useMemo(() => parseAnswer(text), [text]);
  if (blocks.length === 0) return null;
  return (
    <div className="answer-body" data-answer-body>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: AnswerBlock }) {
  switch (block.type) {
    case "heading":
      return (
        <div className={cn("answer-h", `answer-h${block.level}`)} data-answer-block="heading">
          <Inlines nodes={block.inlines} />
        </div>
      );
    case "paragraph":
      return (
        <div className="answer-p" data-answer-block="paragraph">
          <Inlines nodes={block.inlines} />
        </div>
      );
    case "list":
      return (
        <MaybeCollapsed meta={block.meta}>
          <ListView ordered={block.ordered} items={block.items} />
        </MaybeCollapsed>
      );
    case "table":
      return (
        <MaybeCollapsed meta={block.meta}>
          <TableView header={block.header} aligns={block.aligns} rows={block.rows} />
        </MaybeCollapsed>
      );
    case "code":
      return (
        <MaybeCollapsed meta={block.meta}>
          <CodeView text={block.text} />
        </MaybeCollapsed>
      );
    case "quote":
      return (
        <blockquote className="answer-quote" data-answer-block="quote">
          <Inlines nodes={block.inlines} />
        </blockquote>
      );
    case "rule":
      return <hr className="answer-rule" data-answer-block="rule" />;
    case "image":
      return <MessageImage alt={block.alt} source={block.source} />;
    case "section":
      return <SectionView title={block.title} meta={block.meta} body={block.body} />;
    default:
      return null;
  }
}

function MaybeCollapsed({ meta, children }: { meta: CollapseMeta | null; children: ReactNode }) {
  if (!meta) return children;
  return (
    <Disclosure meta={meta} title={null}>
      {children}
    </Disclosure>
  );
}

function SectionView({
  title,
  meta,
  body,
}: {
  title: Inline[];
  meta: CollapseMeta;
  body: AnswerBlock;
}) {
  return (
    <Disclosure meta={meta} title={title}>
      <BlockView block={body} />
    </Disclosure>
  );
}

function Disclosure({
  meta,
  title,
  children,
}: {
  meta: CollapseMeta;
  title: Inline[] | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="answer-section"
      data-answer-disclosure
      data-disclosure-kind={meta.kind}
      data-disclosure-open={open ? "true" : "false"}
    >
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight className={cn("answer-chevron", open && "is-open")} />
        {title ? (
          <span className="answer-h answer-h2">
            <Inlines nodes={title} />
          </span>
        ) : (
          <span className="answer-section-fallback">{meta.fallback}</span>
        )}
        <span className="answer-section-meta">{meta.detail}</span>
      </button>
      {open ? <div className="answer-section-body">{children}</div> : null}
    </div>
  );
}

function ListView({ ordered, items }: { ordered: boolean; items: Inline[][] }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag className="answer-list" data-answer-block="list">
      {items.map((item, index) => (
        <li key={index}>
          <Inlines nodes={item} />
        </li>
      ))}
    </Tag>
  );
}

function TableView({
  header,
  aligns,
  rows,
}: {
  header: Inline[][];
  aligns: Align[];
  rows: Inline[][][];
}) {
  return (
    <div className="answer-table-wrap" data-answer-block="table">
      <table className="answer-table">
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={index} className={alignClass(aligns[index])}>
                <Inlines nodes={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} className={alignClass(aligns[index])}>
                  <Inlines nodes={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function alignClass(align: Align | undefined): string | undefined {
  if (align === "center") return "is-center";
  if (align === "right") return "is-right";
  return undefined;
}

function CodeView({ text }: { text: string }) {
  const lines = codeDisplayLines(text);
  return (
    <pre className="answer-pre" data-answer-block="code">
      <code>
        {lines.map((line, index) => (
          <span key={index}>
            {line.length > 0 ? <Inlines nodes={line} /> : null}
            {index < lines.length - 1 ? "\n" : null}
          </span>
        ))}
      </code>
    </pre>
  );
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineView key={index} node={node} />
      ))}
    </>
  );
}

function InlineView({ node }: { node: Inline }) {
  switch (node.type) {
    case "text":
      return node.text;
    case "break":
      return <br />;
    case "strong":
      return (
        <strong>
          <Inlines nodes={node.inlines} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inlines nodes={node.inlines} />
        </em>
      );
    case "code":
      return (
        <code className="answer-inline-code" title={node.title}>
          {node.display ?? node.text}
        </code>
      );
    case "path":
      return (
        <span className="answer-path" title={node.full}>
          {node.display}
        </span>
      );
    case "link":
      return <LinkView node={node} />;
    case "image":
      return <MessageImage alt={node.alt} source={node.source} />;
    default:
      return null;
  }
}

function LinkView({ node }: { node: Extract<Inline, { type: "link" }> }) {
  const preview = usePreviewOptional();
  if (/^https?:\/\//i.test(node.href)) {
    return (
      <a href={node.href} title={node.title} target="_blank" rel="noreferrer noopener">
        <Inlines nodes={node.inlines} />
      </a>
    );
  }
  if (!isFileHref(node.href) || !preview) {
    if (!isFileHref(node.href)) return <Inlines nodes={node.inlines} />;
    return (
      <span className="answer-file" title={node.title ?? node.href}>
        <Inlines nodes={node.inlines} />
      </span>
    );
  }
  return (
    <button
      type="button"
      className="answer-file"
      title={node.title ?? node.href}
      onClick={() => preview.openHref(node.href)}
    >
      <Inlines nodes={node.inlines} />
    </button>
  );
}
