import { useEffect, useState } from "react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { textSnippetChipLabel, textSnippetPreview } from "@/shared/text-snippet";
import { resolvePreviewPath } from "../core/preview-kind";
import { FileContextMenu } from "./FileContextMenu";
import { FilePreviewColumn } from "./FilePreview";
import { useFilePreviewChrome } from "./use-file-preview-chrome";
import { PreviewChrome } from "./PreviewChrome";
import { projectIdForRoot } from "./preview-project";
import { baseName } from "@/shared/path";
import { useAttachFile } from "./useAttachFile";
import { addSessionTextSnippet, useSessionTextSnippets } from "../core/useAddTextSnippet";
import { WorkspaceTree } from "./WorkspaceTree";

const SESSION = "preview";

/** 开发预览：文件树和选区菜单走真实后端，不造搜索结果。 */
export default function FilesPreview() {
  const root = new URLSearchParams(window.location.search).get("root") ?? "";
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [path, setPath] = useState("");
  const [line, setLine] = useState<number | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const attachFile = useAttachFile(SESSION);
  const snippets = useSessionTextSnippets(SESSION);

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
    <div className="flex h-screen min-h-0 flex-col bg-[var(--wb-canvas)] text-[var(--wb-text)]">
      <PreviewChrome {...chrome.chromeProps} />
      <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <FilePreviewColumn
          projectId={projectId}
          previewPath={path}
          previewLine={line}
          markdownMode={chrome.markdownMode}
          quotePath={path ? joinRoot(root, path) : ""}
          onQuote={(draft) => addSessionTextSnippet(SESSION, draft)}
        />
        <div className="shrink-0 border-t border-[var(--wb-border)] p-3">
          <span className="mb-1 block text-xs text-[var(--wb-muted)]">对话</span>
          {snippets.length > 0 ? (
            <div data-preview-snippets={snippets.length} className="mb-2">
              <p className="text-xs text-[var(--wb-text-strong)]">{textSnippetChipLabel(snippets.length)}</p>
              {snippets.map((snippet) => (
                <pre
                  key={snippet.id}
                  data-preview-snippet
                  className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-xs text-[var(--wb-muted)]"
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
            className="h-28 w-full resize-none rounded-lg border border-[var(--wb-border-strong)] bg-[var(--wb-composer)] p-2 font-mono text-xs text-[var(--wb-text-strong)] placeholder:text-[var(--wb-faint)]"
          />
        </div>
      </div>
      {treeOpen ? (
        <aside data-workspace-tree data-tree-surface="sidebar" className="flex w-80 shrink-0 flex-col border-l border-[var(--wb-border)] bg-[var(--wb-diff-well)]">
          <div className="flex gap-1 border-b border-[var(--wb-border)] p-1.5">
            <input
              data-files-filter
              value={filter}
              aria-label={DESKTOP_ZH.filterFiles}
              placeholder={DESKTOP_ZH.filterFiles}
              onChange={(event) => setFilter(event.target.value)}
              className="w-full min-w-0 rounded-md border border-[var(--wb-border-strong)] bg-[var(--wb-well)] px-1.5 py-1 text-xs text-[var(--wb-text-strong)] outline-none placeholder:text-[var(--wb-faint)] focus:border-[var(--wb-accent)]"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
            {projectId ? (
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
            ) : (
              <p className="px-2 py-6 text-center text-xs text-[var(--wb-muted)]">{error || DESKTOP_ZH.filesReading}</p>
            )}
          </div>
        </aside>
      ) : null}
      </div>
      {chrome.searchDialog}
      {contextMenu ? (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onAdd={() => {
            const absolute = resolvePreviewPath(root, contextMenu.path);
            if (absolute) attachFile(absolute, baseName(absolute));
            setContextMenu(null);
          }}
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
