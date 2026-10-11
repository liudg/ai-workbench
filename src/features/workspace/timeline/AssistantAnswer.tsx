import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Globe } from "lucide-react";

import { backend } from "@/lib/ipc";
import {
  codeDisplayLines,
  inlinePlain,
  parseAnswer,
  type Align,
  type AnswerBlock,
  type CollapseMeta,
  type Inline,
} from "./answer-markdown";
import { cn } from "@/lib/utils";
import { pageTitleFromHtml } from "../changes/browser";
import { CODEX_DESKTOP } from "../codex-desktop";
import {
  baseName,
  fileLineRef,
  isFileHref,
  isHtmlHref,
  lineFromHref,
} from "../changes/model";
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
    case "paragraph": {
      const site = loneHtmlLink(block.inlines);
      if (site) return <WebsiteCard href={site.href} label={site.label} />;
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
      return <MessageImage alt={node.alt} source={node.source} />;
    default:
      return null;
  }
}

function CodeSpan({ node }: { node: Extract<Inline, { type: "code" }> }) {
  const preview = usePreviewOptional();
  const ref = fileLineRef(node.text);
  if (ref && preview && isFileHref(ref.path)) {
    return (
      <button
        type="button"
        className="answer-inline-code"
        data-line-ref={ref.line}
        title={node.title ?? ref.path}
        onClick={() => preview.openHref(ref.path, ref.line)}
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
  const preview = usePreviewOptional();
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
  if ((!isFileHref(target) && !isHtmlHref(node.href)) || !preview) {
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
      onClick={() => preview.openHref(target, line)}
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
  return { href: link.href, label: inlinePlain(link.inlines) || baseName(link.href) };
}

function WebsiteCard({ href, label }: { href: string; label: string }) {
  const preview = usePreviewOptional();
  const projectId = preview?.projectId ?? "";
  const [title, setTitle] = useState(label || baseName(href));
  useEffect(() => {
    if (!projectId || /^https?:\/\//i.test(href)) return;
    let cancel = false;
    void backend
      .readPreviewFile(projectId, href)
      .then((doc) => {
        if (cancel) return;
        const parsed = pageTitleFromHtml(doc.text);
        if (parsed) setTitle(parsed);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [href, projectId]);
  return (
    <div
      data-website-card
      className="my-2 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2"
    >
      <Globe className="h-4 w-4 shrink-0 text-zinc-300" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-zinc-100">{title}</div>
        <div className="text-xs text-zinc-500">{CODEX_DESKTOP.website}</div>
      </div>
      <button
        type="button"
        data-open-with
        className="shrink-0 rounded px-2 py-1 text-xs text-zinc-100 hover:bg-zinc-800"
        onClick={() => preview?.openHref(href)}
      >
        {CODEX_DESKTOP.openWith}
      </button>
    </div>
  );
}
