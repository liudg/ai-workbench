import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { AssistantAnswer } from "../timeline/AssistantAnswer";
import { CODEX_DESKTOP } from "../codex-desktop";
import { usePreview, type PreviewTab } from "./preview-context";
import type { FileChange } from "./model";

export function PreviewPanel() {
  const { tabs, activeId, selectTab, closeTab } = usePreview();
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[tabs.length - 1];
  if (!active) return null;

  return (
    <section
      data-preview-panel
      className="flex h-full min-w-[260px] w-[min(480px,40%)] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950"
    >
      <div className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-zinc-800 px-1">
        {tabs.map((tab) => {
          const selected = tab.id === active.id;
          return (
            <div
              key={tab.id}
              className={cn(
                "flex min-w-0 max-w-[180px] items-center rounded-t-md",
                selected ? "bg-zinc-800 text-zinc-100" : "text-zinc-400",
              )}
            >
              <button
                type="button"
                data-preview-tab={tab.kind}
                className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs"
                onClick={() => selectTab(tab.id)}
              >
                {tab.title}
              </button>
              <button
                type="button"
                aria-label={CODEX_DESKTOP.closeTab}
                className="mr-1 rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100"
                onClick={() => closeTab(tab.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <TabBody tab={active} />
      </div>
    </section>
  );
}

function TabBody({ tab }: { tab: PreviewTab }) {
  if (tab.kind === "diff") return <DiffBody files={tab.files} />;
  if (tab.status === "loading") {
    return <p className="px-4 py-6 text-sm text-zinc-500">正在读取…</p>;
  }
  if (tab.status === "error") {
    return <p className="px-4 py-6 text-sm text-red-300">{tab.error}</p>;
  }
  if (tab.kind === "html") return <HtmlCard title={tab.title} text={tab.text} truncated={tab.truncated} />;
  if (tab.kind === "markdown") {
    return (
      <div className="h-full overflow-auto px-4 py-3">
        {tab.truncated ? <Truncated /> : null}
        <AssistantAnswer text={tab.text} />
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto">
      {tab.truncated ? <Truncated /> : null}
      <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-5 text-zinc-200">
        {tab.text}
      </pre>
    </div>
  );
}

function HtmlCard({
  title,
  text,
  truncated,
}: {
  title: string;
  text: string;
  truncated: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col p-3" data-html-preview>
      {truncated ? <Truncated /> : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-lg shadow-black/30">
        <div className="flex items-center gap-2 border-b border-zinc-700 bg-zinc-800/90 px-3 py-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full bg-zinc-500" />
          <span className="min-w-0 truncate text-xs text-zinc-300">{title}</span>
        </div>
        <iframe
          title={title}
          sandbox=""
          srcDoc={htmlDocument(text)}
          className="min-h-0 w-full flex-1 bg-white"
        />
      </div>
    </div>
  );
}

function DiffBody({ files }: { files: FileChange[] }) {
  if (files.length === 0) {
    return <p className="px-4 py-6 text-sm text-zinc-500">{CODEX_DESKTOP.noFileChanges}</p>;
  }
  return (
    <div className="h-full overflow-auto" data-diff-view>
      {files.map((file) => (
        <section key={file.path} className="border-b border-zinc-800">
          <header className="sticky top-0 flex min-w-0 items-center gap-2 bg-zinc-950/95 px-3 py-2 text-xs">
            <span className="w-4 shrink-0 font-mono text-zinc-400">{file.status}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-zinc-200" title={file.path}>
              {file.path}
            </span>
            <span className="font-mono text-emerald-400">+{file.added}</span>
            <span className="font-mono text-red-400">−{file.removed}</span>
          </header>
          <DiffText diff={file.diff} />
        </section>
      ))}
    </div>
  );
}

function DiffText({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <p className="px-3 py-2 text-xs text-zinc-500">没有可显示的差异文本。</p>;
  }
  return (
    <pre className="overflow-x-auto px-0 py-1 font-mono text-xs leading-5">
      {diff.split(/\r?\n/).map((line, index) => (
        <div key={index} className={cn("px-3", diffLineClass(line))}>
          {line.length > 0 ? line : " "}
        </div>
      ))}
    </pre>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
    return "text-zinc-500";
  }
  if (line.startsWith("@@")) return "text-sky-300/90";
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-300";
  if (line.startsWith("-")) return "bg-red-500/10 text-red-300";
  return "text-zinc-300";
}

function Truncated() {
  return <p className="px-4 pt-3 text-xs text-zinc-500">只显示了文件的开头部分。</p>;
}

function htmlDocument(text: string): string {
  if (/<html[\s>]/i.test(text) || /<!doctype/i.test(text)) return text;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${text}</body></html>`;
}
