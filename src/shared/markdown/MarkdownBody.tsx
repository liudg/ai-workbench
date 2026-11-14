import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy, File, Play } from "lucide-react";

import { cn } from "@/lib/utils";
import { baseName } from "@/shared/path";
import {
  codeDisplayLines,
  inlinePlain,
  parseAnswer,
  type Align,
  type AnswerBlock,
  type CollapseMeta,
  type Inline,
} from "./answer-markdown";
import { visibleFileCiteCount } from "./file-cites";
import { fileLineRef, inlineHtmlPath, isFileHref, isHtmlHref, stripFileLocation } from "./file-href";
import { useMarkdownHost } from "./host";
import { isShellLang } from "./shell-lang";
import { writeClipboardText } from "@/shared/clipboard";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
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
      if (block.meta?.kind === "files") {
        return <FileCiteList items={block.items} label={block.meta.fallback} />;
      }
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
          {isShellLang(block.lang) ? (
            <CommandView text={block.text} run={host?.runCommand} />
          ) : (
            <CodeView text={block.text} />
          )}
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
      if (block.meta.kind === "files" && block.body.type === "list") {
        return (
          <div className="answer-file-section" data-answer-block="file-list">
            <div className="answer-h answer-h2">
              <Inlines nodes={block.title} />
            </div>
            <FileCiteList items={block.body.items} />
          </div>
        );
      }
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

function FileCiteList({ items, label }: { items: Inline[][]; label?: string | null }) {
  const [revealed, setRevealed] = useState(false);
  const count = visibleFileCiteCount(items.length, revealed);
  const hidden = items.length - count;
  return (
    <div className="answer-file-list" data-answer-file-list data-file-count={items.length}>
      {label ? <div className="answer-file-list-label">{label}</div> : null}
      <div className="answer-file-rows">
        {items.slice(0, count).map((item, index) => (
          <div key={index} className="answer-file-row">
            <Inlines nodes={item} />
          </div>
        ))}
      </div>
      {hidden > 0 ? (
        <button type="button" data-show-more className="answer-file-more" onClick={() => setRevealed(true)}>
          显示另外 {hidden} 个
        </button>
      ) : null}
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

/** 终端命令：右上角运行和复制。 */
function CommandView({ text, run }: { text: string; run?: (command: string) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    void writeClipboardText(text).then(() => setCopied(true), () => {});
  };
  return (
    <div className="answer-command" data-answer-block="command">
      <CodeView text={text} />
      <div className="answer-command-actions">
        {run ? (
          <button
            type="button"
            className="answer-command-button"
            title={DESKTOP_ZH.codeRun}
            aria-label={DESKTOP_ZH.codeRun}
            onClick={() => run(text)}
          >
            <Play className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          className="answer-command-button"
          title={copied ? DESKTOP_ZH.codeCopied : DESKTOP_ZH.codeCopy}
          aria-label={copied ? DESKTOP_ZH.codeCopied : DESKTOP_ZH.codeCopy}
          onClick={copy}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

function Inlines({ nodes, inLink = false }: { nodes: Inline[]; inLink?: boolean }) {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineView key={index} node={node} inLink={inLink} />
      ))}
    </>
  );
}

function InlineView({ node, inLink = false }: { node: Inline; inLink?: boolean }) {
  switch (node.type) {
    case "text":
      return node.text;
    case "break":
      return <br />;
    case "strong":
      return (
        <strong>
          <Inlines nodes={node.inlines} inLink={inLink} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inlines nodes={node.inlines} inLink={inLink} />
        </em>
      );
    case "code":
      return <CodeSpan node={node} inLink={inLink} />;
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

function CodeSpan({ node, inLink }: { node: Extract<Inline, { type: "code" }>; inLink: boolean }) {
  const host = useMarkdownHost();
  const ref = fileLineRef(node.text);
  const path = ref?.path ?? inlineHtmlPath(node.text);
  if (!inLink && path && host?.canOpen && isFileHref(path)) {
    return (
      <CitationPill
        path={path}
        line={ref?.line}
        title={path}
        onOpen={() => host.openHref(path, ref?.line)}
      />
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
  if (/^https?:\/\//i.test(node.href) && !isHtmlHref(node.href)) {
    const openLink = host?.openLink;
    return (
      <a
        href={node.href}
        title={node.title}
        target="_blank"
        rel="noreferrer noopener"
        onClick={
          openLink
            ? (event) => {
                event.preventDefault();
                openLink(node.href);
              }
            : undefined
        }
      >
        <Inlines nodes={node.inlines} inLink />
      </a>
    );
  }
  const target = fileLinkTarget(node.href, plain);
  if (!isFileHref(target.path) && !isHtmlHref(node.href)) return <Inlines nodes={node.inlines} />;
  return (
    <CitationPill
      path={target.path}
      line={target.line}
      title={target.path}
      onOpen={host?.canOpen ? () => host.openHref(target.path, target.line) : null}
    />
  );
}

function fileLinkTarget(href: string, plain: string): { path: string; line?: number } {
  const label = fileLineRef(plain);
  const fromHref = stripFileLocation(href);
  const line = label?.line ?? fromHref.line ?? undefined;
  return { path: fromHref.path || label?.path || href, line };
}

function CitationPill({
  path,
  line,
  title,
  onOpen,
}: {
  path: string;
  line?: number;
  title?: string;
  onOpen: (() => void) | null;
}) {
  const name = baseName(path) || path;
  const tip = title ?? (line != null ? `${path}:${line}` : path);
  const body = (
    <>
      <File className="answer-cite-icon" aria-hidden />
      <span className="answer-cite-name">{name}</span>
      {line != null ? <span className="answer-cite-line">{line}</span> : null}
    </>
  );
  if (!onOpen) {
    return (
      <span className="answer-cite" data-answer-cite data-cite-path={path} title={tip}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="answer-cite"
      data-answer-cite
      data-cite-path={path}
      data-cite-line={line}
      data-line-ref={line}
      title={tip}
      onClick={onOpen}
    >
      {body}
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
