import { useEffect, useState } from "react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { textSnippetChipLabel, textSnippetPreview } from "@/shared/text-snippet";
import { resolvePreviewPath } from "../core/preview-kind";
import { FileContextMenu } from "./FileContextMenu";
import { FilePreview } from "./FilePreview";
import { projectIdForRoot } from "./preview-project";
import { FileSearchDialog } from "./FileSearchDialog";
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
  const [searchOpen, setSearchOpen] = useState(false);
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

  return (
    <div className="flex h-screen min-h-0 bg-zinc-950 text-zinc-200">
      <div className="flex min-w-0 flex-1 flex-col">
        {path && projectId ? (
          <div className="min-h-0 flex-1">
            <FilePreview
              projectId={projectId}
              path={path}
              line={line}
              quotePath={joinRoot(root, path)}
              onQuote={(draft) => addSessionTextSnippet(SESSION, draft)}
            />
          </div>
        ) : (
          <p className="p-6 text-sm text-zinc-500" data-files-preview-status>
            {error || "从右侧打开一个文件"}
          </p>
        )}
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
      <aside data-workspace-tree className="flex w-80 shrink-0 flex-col border-l border-zinc-800">
        <div className="flex gap-1 border-b border-zinc-800 p-1.5">
          <input
            data-files-filter
            value={filter}
            aria-label={DESKTOP_ZH.filterFiles}
            placeholder={DESKTOP_ZH.filterFiles}
            onChange={(event) => setFilter(event.target.value)}
            className="w-full min-w-0 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-100 outline-none"
          />
          <button
            type="button"
            data-file-search-open
            aria-label={DESKTOP_ZH.openFilesSearch}
            className="inline-flex h-7 shrink-0 items-center rounded-full border border-zinc-700 px-2 text-[11px] text-zinc-300"
            onClick={() => setSearchOpen(true)}
          >
            搜索
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
          {projectId ? (
            <WorkspaceTree
              projectId={projectId}
              filter={filter}
              activePath={path}
              onSelect={(next) => {
                setPath(next);
                setLine(null);
              }}
              onContextMenu={(next, event) => setContextMenu({ x: event.clientX, y: event.clientY, path: next })}
            />
          ) : (
            <p className="px-2 py-6 text-center text-xs text-zinc-500">{error || DESKTOP_ZH.filesReading}</p>
          )}
        </div>
      </aside>
      {searchOpen && projectId ? (
        <FileSearchDialog
          projectId={projectId}
          onClose={() => setSearchOpen(false)}
          onOpen={(next, nextLine) => {
            setPath(next);
            setLine(nextLine);
            setSearchOpen(false);
          }}
        />
      ) : null}
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
