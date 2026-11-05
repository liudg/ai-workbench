import { useEffect, useState } from "react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { textSnippetChipLabel, textSnippetPreview } from "@/shared/text-snippet";
import { usePanel } from "@/features/panel/core/PanelProvider";
import { resolvePreviewPath } from "@/features/panel/core/preview-kind";
import { ContextMenu } from "@/features/panel/core/ContextMenu";
import { FilePreviewColumn } from "@/features/panel/files/FilePreview";
import { PreviewChrome } from "@/features/panel/files/PreviewChrome";
import { useFilePreviewChrome } from "@/features/panel/files/use-file-preview-chrome";
import { useAttachFile } from "@/features/panel/files/useAttachFile";
import { WorkspaceTree } from "@/features/panel/files/WorkspaceTree";
import { ProjectPanel, useComposerDraft } from "@/features/workspace";
import { baseName } from "@/shared/path";
import { projectIdForRoot } from "./preview-project";

/** 开发预览：文件树和选区菜单走 daemon 读真实目录，不造搜索结果。`?root=` 给目录。 */
export default function FilesPreview() {
  const root = new URLSearchParams(window.location.search).get("root") ?? "";
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!root) {
      setError("没有项目目录");
      return;
    }
    let cancel = false;
    void (async () => {
      try {
        const id = await projectIdForRoot(root, "search-fixture");
        if (!cancel) setProjectId(id);
      } catch (err: unknown) {
        if (!cancel) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancel = true;
    };
  }, [root]);

  if (!projectId) {
    return <p className="p-6 text-sm text-zinc-400">{error || DESKTOP_ZH.filesReading}</p>;
  }
  return (
    <ProjectPanel projectId={projectId} path={root} title="search-fixture">
      <FilesBody root={root} projectId={projectId} />
    </ProjectPanel>
  );
}

function FilesBody({ root, projectId }: { root: string; projectId: string }) {
  const panel = usePanel();
  const [filter, setFilter] = useState("");
  const [path, setPath] = useState("");
  const [line, setLine] = useState<number | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const attachFile = useAttachFile(panel.sessionId);
  const snippets = useComposerDraft(panel.sessionId).draft.snippets;

  const chrome = useFilePreviewChrome({
    projectId,
    projectPath: root,
    previewPath: path,
    treeOpen,
    onToggleTree: () => setTreeOpen((open) => !open),
    onSelectFile: (next, _intent, nextLine) => {
      setPath(next);
      setLine(nextLine ?? null);
    },
  });

  return (
    <div className="flex h-screen min-h-0 flex-col bg-zinc-950 text-zinc-200">
      <PreviewChrome {...chrome.chromeProps} />
      <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <FilePreviewColumn
          projectId={projectId}
          previewPath={path}
          previewLine={line}
          markdownMode={chrome.markdownMode}
          onToggleMarkdown={chrome.chromeProps.onToggleMarkdown}
          quotePath={path ? joinRoot(root, path) : ""}
          onQuote={(draft) => panel.data.addTextSnippet(panel.sessionId, draft)}
        />
        <div className="shrink-0 border-t border-zinc-800 p-3">
          <span className="mb-1 block text-xs text-zinc-500">对话</span>
          {snippets.length > 0 ? (
            <div data-preview-snippets={snippets.length} className="mb-2">
              <p className="text-xs text-zinc-300">{textSnippetChipLabel(snippets.length)}</p>
              {snippets.map((snippet) => (
                <pre
                  key={snippet.id}
                  data-preview-snippet
                  className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-xs text-zinc-400"
                >
                  {textSnippetPreview(snippet.body)}
                </pre>
              ))}
            </div>
          ) : null}
          <textarea
            data-preview-composer
            readOnly
            value=""
            placeholder="随心输入"
            className="h-28 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs text-zinc-100"
          />
        </div>
      </div>
      {treeOpen ? (
        <aside data-workspace-tree data-tree-surface="sidebar" className="flex w-80 shrink-0 flex-col border-l border-zinc-800">
          <div className="flex gap-1 border-b border-zinc-800 p-1.5">
            <input
              data-files-filter
              value={filter}
              aria-label={DESKTOP_ZH.filterFiles}
              placeholder={DESKTOP_ZH.filterFiles}
              onChange={(event) => setFilter(event.target.value)}
              className="w-full min-w-0 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-100 outline-none"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
            {(
              <WorkspaceTree
                projectId={projectId}
                filter={filter}
                activePath={path}
                surface="sidebar"
                onSelectFile={(next) => {
                  setPath(next);
                  setLine(null);
                }}
                onContextMenu={(next, event) => setContextMenu({ x: event.clientX, y: event.clientY, path: next })}
              />
            )}
          </div>
        </aside>
      ) : null}
      </div>
      {chrome.searchDialog}
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            {
              id: "add-to-chat",
              label: DESKTOP_ZH.addToChat,
              onSelect: () => {
                const absolute = resolvePreviewPath(root, contextMenu.path);
                if (absolute) attachFile(absolute, baseName(absolute));
              },
            },
          ]}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}

function joinRoot(root: string, path: string): string {
  const base = root.replace(/[\\/]+$/, "");
  const slash = root.includes("\\") ? "\\" : "/";
  return `${base}${slash}${path.replace(/^[\\/]+/, "")}`;
}
