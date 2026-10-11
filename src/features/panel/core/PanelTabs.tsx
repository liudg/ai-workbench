import { FileDiff, Globe, Plus, X } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { cn } from "@/lib/utils";
import { BrowserView } from "../browser/BrowserView";
import { DiffView } from "../diff/DiffView";
import { MarkdownPreview } from "../viewers/MarkdownPreview";
import { SourceView } from "../viewers/SourceView";
import { TextPreview } from "../viewers/TextPreview";
import { usePanel, type PanelTab } from "./PanelProvider";

export function PanelTabs() {
  const { tabs, activeId, selectTab, closeTab, openBlank, setTabTitle, projectId } = usePanel();
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
                className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5 text-left text-xs"
                onClick={() => selectTab(tab.id)}
              >
                {tab.kind === "diff" ? (
                  <FileDiff className="h-3 w-3 shrink-0" data-tab-icon="diff" />
                ) : null}
                {tab.kind === "html" ? <Globe className="h-3 w-3 shrink-0" data-tab-icon="web" /> : null}
                <span className="truncate">{tab.title}</span>
              </button>
              <button
                type="button"
                aria-label={DESKTOP_ZH.closeTab}
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
          aria-label={DESKTOP_ZH.browserNewTab}
          title={DESKTOP_ZH.browserNewTab}
          className="my-1 shrink-0 rounded px-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          onClick={openBlank}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <TabBody key={active.id} tab={active} projectId={projectId} onTitle={setTabTitle} />
      </div>
    </section>
  );
}

function TabBody({
  tab,
  projectId,
  onTitle,
}: {
  tab: PanelTab;
  projectId: string;
  onTitle: (id: string, title: string) => void;
}) {
  if (tab.kind === "diff") return <DiffView files={tab.files} />;
  if (tab.line != null) {
    if (tab.status === "loading") return <p className="px-4 py-6 text-sm text-zinc-500">正在读取…</p>;
    if (tab.status === "error") return <p className="px-4 py-6 text-sm text-red-300">{tab.error}</p>;
    return <SourceView text={tab.text} line={tab.line} />;
  }
  if (tab.kind === "html") {
    if (tab.status === "error") {
      return <p className="px-4 py-6 text-sm text-red-300">{tab.error}</p>;
    }
    return (
      <BrowserView
        tabId={tab.id}
        projectId={projectId}
        path={tab.path}
        initialUrl={tab.url}
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
    return <MarkdownPreview text={tab.text} truncated={tab.truncated} />;
  }
  return <TextPreview text={tab.text} truncated={tab.truncated} />;
}

