import { Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { AssistantAnswer } from "../timeline/AssistantAnswer";
import { CODEX_DESKTOP } from "../codex-desktop";
import { BrowserView } from "./BrowserView";
import { usePreview, type PreviewTab } from "./preview-context";
import type { FileChange } from "./model";

export function PreviewPanel() {
  const { tabs, activeId, selectTab, closeTab, openBlank, setTabTitle, projectId } = usePreview();
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[tabs.length - 1];
  if (!active) return null;

  return (
    <section
      data-preview-panel
      className="flex h-full min-w-[300px] w-[min(560px,44%)] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950"
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
        <button
          type="button"
          data-browser-new-tab
          aria-label={CODEX_DESKTOP.browserNewTab}
          title={CODEX_DESKTOP.browserNewTab}
          className="my-1 shrink-0 rounded px-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          onClick={openBlank}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <TabBody tab={active} projectId={projectId} onTitle={setTabTitle} />
      </div>
    </section>
  );
}

function TabBody({
  tab,
  projectId,
  onTitle,
}: {
  tab: PreviewTab;
  projectId: string;
  onTitle: (id: string, title: string) => void;
}) {
  if (tab.kind === "diff") return <DiffBody files={tab.files} />;
  if (tab.kind === "html") {
    if (tab.status === "error") {
      return <p className="px-4 py-6 text-sm text-red-300">{tab.error}</p>;
    }
    return (
      <BrowserView
        tabId={tab.id}
        projectId={projectId}
        path={tab.path}
        text={tab.text}
        onTitle={(title) => onTitle(tab.id, title)}
      />
    );
  }
  if (tab.status === "loading") {
    return <p className="px-4 py-6 text-sm text-zinc-500">正在读取…</p>;
  }
  if (tab.status === "error") {
    return <p className="px-4 py-6 text-sm text-red-300">{tab.error}</p>;
  }
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

