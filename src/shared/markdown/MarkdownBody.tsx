import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  codeDisplayLines,
  inlinePlain,
  parseAnswer,
  type Align,
  type AnswerBlock,
  type CollapseMeta,
  type Inline,
} from "./answer-markdown";
import { fileLineRef, isFileHref, isHtmlHref, lineFromHref } from "./file-href";
import { useMarkdownHost } from "./host";
import type { ImageSource } from "./markdown-images";

export function MarkdownBody({ text }: { text: string }) {
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
  const host = useMarkdownHost();
  switch (block.type) {
    case "heading":
      return (
        <div className={cn("answer-h", `answer-h${block.level}`)} data-answer-block="heading">
          <Inlines nodes={block.inlines} />
        </div>
      );
    case "paragraph": {
      const site = loneHtmlLink(block.inlines);
      if (site && host) return <>{host.renderWebsite(site.href, site.label)}</>;
      return (
        <div className="answer-p" data-answer-block="paragraph">
          <Inlines nodes={block.inlines} />
        </div>
      );
    }
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
      return <HostImage alt={block.alt} source={block.source} />;
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
      return <CodeSpan node={node} />;
    case "path":
      return (
        <span className="answer-path" title={node.full}>
          {node.display}
        </span>
      );
    case "link":
      return <LinkView node={node} />;
    case "image":
      return <HostImage alt={node.alt} source={node.source} />;
    default:
      return null;
  }
}

function HostImage({ alt, source }: { alt: string; source: ImageSource }) {
  const host = useMarkdownHost();
  if (host) return host.renderImage(alt, source);
  if (source.type === "https") {
    return <img src={source.url} alt={alt} className="my-2 block max-h-96 max-w-full" />;
  }
  return <span className="answer-path">{source.path}</span>;
}

function CodeSpan({ node }: { node: Extract<Inline, { type: "code" }> }) {
  const host = useMarkdownHost();
  const ref = fileLineRef(node.text);
  if (ref && host?.canOpen && isFileHref(ref.path)) {
    return (
      <button
        type="button"
        className="answer-inline-code"
        data-line-ref={ref.line}
        title={node.title ?? ref.path}
        onClick={() => host.openHref(ref.path, ref.line)}
      >
        {node.display ?? node.text}
      </button>
    );
  }
  return (
    <code className="answer-inline-code" title={node.title}>
      {node.display ?? node.text}
    </code>
  );
}

function LinkView({ node }: { node: Extract<Inline, { type: "link" }> }) {
  const host = useMarkdownHost();
  const plain = inlinePlain(node.inlines);
  const ref = fileLineRef(plain);
  const line = ref?.line ?? lineFromHref(node.href) ?? undefined;
  const target = ref?.path ?? node.href;
  if (/^https?:\/\//i.test(node.href) && !isHtmlHref(node.href)) {
    return (
      <a href={node.href} title={node.title} target="_blank" rel="noreferrer noopener">
        <Inlines nodes={node.inlines} />
      </a>
    );
  }
  if ((!isFileHref(target) && !isHtmlHref(node.href)) || !host?.canOpen) {
    if (!isFileHref(target) && !isHtmlHref(node.href)) return <Inlines nodes={node.inlines} />;
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
      data-line-ref={line}
      title={node.title ?? node.href}
      onClick={() => host.openHref(target, line)}
    >
      <Inlines nodes={node.inlines} />
    </button>
  );
}

function loneHtmlLink(inlines: Inline[]): { href: string; label: string } | null {
  const content = inlines.filter(
    (node) => node.type !== "break" && !(node.type === "text" && node.text.trim() === ""),
  );
  if (content.length !== 1 || content[0].type !== "link") return null;
  const link = content[0];
  if (!isHtmlHref(link.href)) return null;
  return { href: link.href, label: inlinePlain(link.inlines) || hrefLabel(link.href) };
}

function hrefLabel(href: string): string {
  const bare = href.split(/[?#]/)[0] ?? href;
  const parts = bare.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? href;
}
