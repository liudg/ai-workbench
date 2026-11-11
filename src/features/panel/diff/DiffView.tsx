import { useEffect, useMemo, useRef, useState } from "react";

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
import { setFileFilter } from "../core/file-filter";
import { DiffFileSection } from "./DiffFileSection";
import { DiffToolbar } from "./DiffToolbar";
import { copyApplyState } from "./git-apply";
import { jumpSelection, visibleJumpFiles } from "./jump-files";
import { diffPresentation, nextDiffLayout, type DiffLayoutMode } from "./split-rows";
import { useDiffDocument } from "./useDiffDocument";
import { useGitWorkTree } from "./useGitWorkTree";

const SPLITTER_WIDTH = 6;

export function DiffView({ files }: { files: FileChange[] }) {
  const { diffFilesWidth, setDiffFilesWidth, projectId, projectPath, sessionId, diffView, patchDiffView } =
    usePanel();
  const displayFiles = useMemo(() => relativizeFiles(files, projectPath), [files, projectPath]);
  const doc = useDiffDocument(displayFiles);
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
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
            className={cn(
              "min-h-0 min-w-0 flex-1 overflow-y-auto",
              doc.wrap ? "overflow-x-hidden" : "overflow-x-auto",
            )}
            data-diff-wrap={doc.wrap ? "on" : "off"}
          >
            {doc.loading ? <p className="px-4 py-6 text-sm text-[var(--wb-muted)]">正在读取…</p> : null}
            {doc.gitError ? <p className="px-4 py-6 text-sm text-[var(--wb-danger-text)]">{doc.gitError}</p> : null}
            {!doc.loading && !doc.gitError && doc.shown.length === 0 ? (
              <p className="px-4 py-6 text-sm text-[var(--wb-muted)]">{DESKTOP_ZH.noFileChanges}</p>
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
              />
            ))}
          </div>
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
              <p className="px-2 py-6 text-center text-xs leading-5 text-[var(--wb-muted)]">{DESKTOP_ZH.noFileChanges}</p>
            }
          />
        ) : null}
      </div>
    </div>
  );
}
