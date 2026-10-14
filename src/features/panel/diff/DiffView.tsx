import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { useElementWidth } from "@/shared/dom/useElementWidth";
import type { FileChange } from "@/features/changes-model/diff-parse";
import { diffListWidth, diffListWidthAfterDrag } from "../core/layout";
import { ColumnSplitter } from "../core/ColumnSplitter";
import { usePanel } from "../core/PanelProvider";
import { ChangesSidebar } from "../files/ChangesSidebar";
import { setFileFilter } from "../core/file-filter";
import { DiffFileSection } from "./DiffFileSection";
import { DiffToolbar } from "./DiffToolbar";
import { copyApplyState } from "./git-apply";
import { diffPresentation, nextDiffLayout, type DiffLayoutMode } from "./split-rows";
import { useDiffDocument } from "./useDiffDocument";
import { useGitWorkTree } from "./useGitWorkTree";

const SPLITTER_WIDTH = 6;

export function DiffView({ files }: { files: FileChange[] }) {
  const { diffFilesWidth, setDiffFilesWidth, projectId, sessionFiles } = usePanel();
  const threadFiles = sessionFiles.length > 0 ? sessionFiles : files;
  const [followThread, setFollowThread] = useState(false);
  const doc = useDiffDocument(followThread ? threadFiles : files);
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const paneWidth = useElementWidth(frameRef);
  const contentWidth = useElementWidth(contentRef);
  const [epoch, setEpoch] = useState(0);
  const [gitEpoch, setGitEpoch] = useState(0);
  const [filesWanted, setFilesWanted] = useState(true);
  const [layout, setLayout] = useState<DiffLayoutMode>("auto");
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const git = useGitWorkTree(projectId, gitEpoch);
  const copy = copyApplyState({ git: git.status, gitReason: git.reason, patch: doc.patch });
  const presentation = diffPresentation(layout, contentWidth);
  const inner = Math.max(0, paneWidth - SPLITTER_WIDTH);
  const auto = filesWanted ? diffListWidth(inner) : null;
  const listWidth =
    auto === null ? null : diffFilesWidth === null ? auto : diffListWidthAfterDrag(inner, diffFilesWidth);
  const metrics = useRef({ pane: 0, list: 0 });
  const widthRef = useRef(diffFilesWidth);
  metrics.current = { pane: inner, list: listWidth ?? auto ?? 0 };
  widthRef.current = diffFilesWidth;
  const sourceFor = (path: string) => (doc.loadFull ? (doc.sources[path] ?? null) : null);

  useEffect(() => {
    if (!pendingJump) return;
    const file = doc.shown.find((item) => item.path === pendingJump);
    if (!file) return;
    setPendingJump(null);
    doc.revealFile(file);
  }, [doc.revealFile, doc.shown, pendingJump]);

  const jumpTo = (path: string) => {
    const known = threadFiles.some((file) => file.path === path) || files.some((file) => file.path === path);
    if (!known) return;
    setFileFilter("");
    const inListed = doc.listed.some((file) => file.path === path);
    if (!inListed) {
      const turn = doc.scopes.find((item) => item.source === "turn" && !item.submenu);
      if (turn && doc.scope !== turn.id) doc.setScope(turn.id);
      if (!followThread) setFollowThread(true);
    }
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
        onToggleLayout={() => setLayout((value) => nextDiffLayout(value, contentWidth))}
        wrap={doc.wrap}
        onToggleWrap={() => doc.setWrap((value) => !value)}
        onRefresh={() => {
          setFileFilter("");
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
        filesOpen={listWidth !== null}
        onToggleFiles={() => setFilesWanted((value) => !value)}
        jumpFiles={threadFiles}
        activePath={doc.active?.path ?? ""}
        onJump={jumpTo}
        copyCommand={copy.command}
        copyReason={copy.reason}
      />
      <div data-diff-split className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div ref={contentRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div
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
              />
            ))}
          </div>
        </div>
        {listWidth !== null ? (
          <ColumnSplitter
            name="diff-files"
            onDelta={(dx) => {
              const pane = metrics.current.pane;
              const current = diffListWidthAfterDrag(pane, widthRef.current ?? metrics.current.list) ?? metrics.current.list;
              const next = diffListWidthAfterDrag(pane, current - dx);
              if (next !== null) setDiffFilesWidth(next);
            }}
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
    </div>
  );
}
