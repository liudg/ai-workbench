import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { useElementWidth } from "@/shared/dom/useElementWidth";
import type { FileChange } from "@/features/changes-model/diff-parse";
import { nextDraggedListWidth, paneFileColumnWidth } from "../core/layout";
import { ColumnSplitter } from "../core/ColumnSplitter";
import { useColumnGesture } from "../core/useColumnGesture";
import { usePanel } from "../core/PanelProvider";
import { ChangesSidebar } from "../files/ChangesSidebar";
import { relativizeFiles } from "@/shared/path";
import { SelectionMenu } from "@/shared/selection/SelectionMenu";
import type { TextSnippetDraft } from "@/shared/text-snippet";
import { ContextMenu, type ContextMenuItem } from "@/shared/menu/ContextMenu";
import { resolvePreviewPath } from "../core/preview-kind";
import { clipboardItems, copyPathItem, snippetItems, snippetSelectionActions } from "../viewers/content-menu";
import { commentRowOf, useLineComments, type CommentSpan } from "../viewers/line-comments";
import { setFileFilter } from "../core/file-filter";
import { DiffFileSection, type DiffLineHit, type SpanDrafts } from "./DiffFileSection";
import { DiffToolbar } from "./DiffToolbar";
import { copyApplyState } from "./git-apply";
import { jumpSelection, visibleJumpFiles } from "./jump-files";
import { diffPresentation, nextDiffLayout, type DiffLayoutMode } from "./split-rows";
import { useDiffDocument } from "./useDiffDocument";
import { useGitWorkTree } from "./useGitWorkTree";

const SPLITTER_WIDTH = 6;

export function DiffView({ files, focus, onFocusHandled }: {
  files: FileChange[];
  focus?: { path: string };
  onFocusHandled?: () => void;
}) {
  const {
    diffFilesWidth,
    setDiffFilesWidth,
    projectId,
    projectPath,
    sessionId,
    diffView,
    patchDiffView,
    data,
    openHref,
  } = usePanel();
  const displayFiles = useMemo(() => relativizeFiles(files, projectPath), [files, projectPath]);
  const doc = useDiffDocument(displayFiles, focus, onFocusHandled);
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const comments = useLineComments();
  const spans = useRef<SpanDrafts>(new Map()).current;
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const paneWidth = useElementWidth(frameRef);
  const contentWidth = useElementWidth(contentRef);
  const [epoch, setEpoch] = useState(0);
  const [gitEpoch, setGitEpoch] = useState(0);
  const [filesWanted, setFilesWanted] = useState(diffView.filesOpen);
  const [layout, setLayout] = useState<DiffLayoutMode>(diffView.layout);
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const git = useGitWorkTree(projectId, gitEpoch);
  const copy = copyApplyState({ git: git.status, gitReason: git.reason, patch: doc.patch });
  const presentation = diffPresentation(layout, contentWidth);
  const inner = Math.max(0, paneWidth - SPLITTER_WIDTH);
  const listWidth = paneFileColumnWidth({
    paneWidth,
    splitter: SPLITTER_WIDTH,
    wanted: filesWanted,
    dragged: diffFilesWidth,
  });
  const metrics = useRef({ pane: 0, list: 0 });
  const drag = useColumnGesture(listWidth ?? 0, sessionId);
  metrics.current = { pane: inner, list: listWidth ?? 0 };
  const sourceFor = (path: string) => (doc.loadFull ? (doc.sources[path] ?? null) : null);

  useEffect(() => {
    if (!pendingJump) return;
    const file = doc.shown.find((item) => item.path === pendingJump);
    if (!file) return;
    setPendingJump(null);
    doc.revealFile(file);
  }, [doc.revealFile, doc.shown, pendingJump]);

  // 统一和并排的行序号不一样，换布局时收起没写完的评论。
  const closeComment = comments.close;
  useEffect(() => closeComment(), [closeComment, presentation]);

  const quotePathOf = (path: string) => resolvePreviewPath(projectPath, path) ?? path;
  const addSnippet = (draft: TextSnippetDraft) => data.addTextSnippet(sessionId, draft);
  /** 选区按整行引用，只取一份文件的一栏；跨了文件或左右栏就不给引用。 */
  const readSelection = (root: HTMLElement) => {
    const span = selectedSpan(root);
    return span ? (spans.get(span.scope)?.(span.start, span.end) ?? null) : null;
  };
  const showMenu = (event: ReactMouseEvent, hit: DiffLineHit | null) => {
    const root = scrollRef.current;
    if (!root) return;
    event.preventDefault();
    const pickedSpan = selectedSpan(root);
    const picked = pickedSpan ? (spans.get(pickedSpan.scope)?.(pickedSpan.start, pickedSpan.end) ?? null) : null;
    const span = picked ? pickedSpan : hit ? { scope: hit.scope, start: hit.row, end: hit.row } : null;
    const target = picked ?? hit?.draft ?? null;
    const path = span ? pathOfScope(span.scope) : "";
    const file = doc.shown.find((item) => item.path === path);
    const items: ContextMenuItem[] = [
      ...snippetItems(target, addSnippet, () => {
        if (span) comments.open(span, null);
      }),
      { id: "sep-clipboard", separator: true },
      ...clipboardItems(root),
      { id: "sep-path", separator: true },
      copyPathItem(path, target?.start ?? null, target?.end ?? null),
      {
        id: "open-in-files",
        label: DESKTOP_ZH.openInFiles,
        disabled: !file || file.status === "D",
        onSelect: () => {
          if (file) openHref(quotePathOf(file.path), target?.start ?? undefined);
        },
      },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const jumpTo = (path: string) => {
    if (!jumpSelection(doc.shown, path)) return;
    setFileFilter(sessionId, "");
    setPendingJump(path);
  };

  return (
    <div
      ref={frameRef}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-diff-view
      data-diff-list={listWidth === null ? "hidden" : "visible"}
      data-diff-files-width={listWidth ?? undefined}
      data-diff-layout={layout}
      data-diff-presentation={presentation}
      data-diff-expanded={doc.expanded ? "on" : "off"}
      data-diff-git={git.status}
      data-diff-content-width={contentWidth || undefined}
    >
      <DiffToolbar
        scope={doc.scope}
        scopes={doc.scopes}
        onScope={doc.setScope}
        added={doc.added}
        removed={doc.removed}
        expanded={doc.expanded}
        onToggleExpanded={() => {
          if (doc.expanded) doc.collapseAll();
          else doc.expandAll(doc.shown.map((file) => file.path));
        }}
        layoutSplit={presentation === "split"}
        onToggleLayout={() => {
          const next = nextDiffLayout(layout, contentWidth);
          setLayout(next);
          patchDiffView({ layout: next });
        }}
        wrap={doc.wrap}
        onToggleWrap={() => doc.setWrap((value) => !value)}
        onRefresh={() => {
          setFileFilter(sessionId, "");
          setEpoch((value) => value + 1);
          setGitEpoch((value) => value + 1);
          doc.reload();
        }}
        loadFull={doc.loadFull}
        onToggleLoadFull={() => doc.setLoadFull((value) => !value)}
        renderPreview={doc.renderPreview}
        onToggleRenderPreview={() => doc.setRenderPreview((value) => !value)}
        wordDiff={doc.wordDiff}
        onToggleWordDiff={() => doc.setWordDiff((value) => !value)}
        hideWs={doc.hideWs}
        onToggleHideWs={() => doc.setHideWs((value) => !value)}
        hideImports={doc.hideImports}
        onToggleHideImports={() => doc.setHideImports((value) => !value)}
        filesOpen={filesWanted}
        onToggleFiles={() => {
          const next = !filesWanted;
          setFilesWanted(next);
          patchDiffView({ filesOpen: next });
        }}
        jumpFiles={visibleJumpFiles(doc.shown)}
        activePath={doc.active?.path ?? ""}
        onJump={jumpTo}
        copyCommand={copy.command}
        copyReason={copy.reason}
      />
      <div data-diff-split className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div ref={contentRef} className="flex min-h-0 w-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden">
          <div
            ref={scrollRef}
            onContextMenu={(event) => showMenu(event, null)}
            className={cn(
              "min-h-0 min-w-0 flex-1 overflow-y-auto",
              doc.wrap ? "overflow-x-hidden" : "overflow-x-auto",
            )}
            data-diff-wrap={doc.wrap ? "on" : "off"}
          >
            {doc.loading ? <p className="px-4 py-6 text-sm text-zinc-500">正在读取…</p> : null}
            {doc.gitError ? <p className="px-4 py-6 text-sm text-red-300">{doc.gitError}</p> : null}
            {!doc.loading && !doc.gitError && doc.shown.length === 0 ? (
              <p className="px-4 py-6 text-sm text-zinc-500">{DESKTOP_ZH.noFileChanges}</p>
            ) : null}
            {doc.shown.map((file) => (
              <DiffFileSection
                key={file.path}
                file={file}
                open={doc.isOpen(file.path)}
                onToggle={() => doc.toggleFile(file.path)}
                presentation={presentation}
                wrap={doc.wrap}
                wordDiff={doc.wordDiff}
                renderPreview={doc.renderPreview}
                source={sourceFor(file.path)}
                hideImports={doc.hideImports}
                hideWhitespace={doc.hideWs}
                loadFull={doc.loadFull}
                active={file.path === doc.active?.path}
                onSelect={() => doc.selectFile(file)}
                onActivate={() => doc.activateFile(file)}
                comment={{ comments, quotePath: quotePathOf(file.path), onAdd: addSnippet, spans }}
                onLineMenu={showMenu}
              />
            ))}
          </div>
          <SelectionMenu
            rootRef={scrollRef}
            readDraft={readSelection}
            actions={snippetSelectionActions(addSnippet, (_draft) => {
              const root = scrollRef.current;
              const span = root ? selectedSpan(root) : null;
              if (span) comments.open(span, null);
            })}
          />
        </div>
        {listWidth !== null ? (
          <ColumnSplitter
            name="diff-files"
            onDelta={(dx) => {
              const next = nextDraggedListWidth(metrics.current.pane, drag.base(), dx);
              if (next === null) return;
              drag.remember(next);
              setDiffFilesWidth(next);
            }}
            onSettle={drag.settle}
          />
        ) : null}
        {listWidth !== null ? (
          <ChangesSidebar
            key={epoch}
            files={doc.listed}
            activePath={doc.active?.path ?? ""}
            rowAttr="data-diff-file"
            mark="diff"
            width={listWidth}
            onSelect={doc.revealFile}
            empty={
              <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">{DESKTOP_ZH.noFileChanges}</p>
            }
          />
        ) : null}
      </div>
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

/** 评论栏的 scope 里带着文件路径，见 diffCommentScope。 */
function pathOfScope(scope: string): string {
  const at = scope.indexOf(":");
  return at < 0 ? "" : scope.slice(at + 1);
}

/** 选区首尾落在哪几行。首尾不在同一份文件的同一栏就不算。选到下一行行首时不把那一行算进去。 */
function selectedSpan(root: HTMLElement): CommentSpan | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const start = commentRowOf(range.startContainer);
  const end = commentRowOf(range.endContainer);
  if (!start || !end || start.scope !== end.scope) return null;
  const last = range.endOffset === 0 && end.row > start.row ? end.row - 1 : end.row;
  return { scope: start.scope, start: Math.min(start.row, last), end: Math.max(start.row, last) };
}
