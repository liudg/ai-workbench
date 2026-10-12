import { useRef, useState } from "react";

import { backend } from "@/lib/ipc";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { useElementWidth } from "@/shared/dom/useElementWidth";
import type { FileChange } from "@/features/changes-model/diff-parse";
import { diffListWidth, diffListWidthAfterDrag } from "../core/layout";
import { ColumnSplitter } from "../core/ColumnSplitter";
import { usePanel } from "../core/PanelProvider";
import { ChangesSidebar } from "../files/ChangesSidebar";
import { setFileFilter } from "../files/file-filter";
import { DiffFileSection } from "./DiffFileSection";
import { DiffToolbar } from "./DiffToolbar";
import { useDiffDocument } from "./useDiffDocument";

const SPLITTER_WIDTH = 6;

export function DiffView({ files }: { files: FileChange[] }) {
  const doc = useDiffDocument(files);
  const { filesSidebarOpen, toggleFilesSidebar, projectId } = usePanel();
  const frameRef = useRef<HTMLDivElement>(null);
  const paneWidth = useElementWidth(frameRef);
  const [listOverride, setListOverride] = useState<number | null>(null);
  const [epoch, setEpoch] = useState(0);
  const inner = filesSidebarOpen ? Math.max(0, paneWidth - SPLITTER_WIDTH) : paneWidth;
  const auto = filesSidebarOpen ? diffListWidth(inner) : null;
  const listWidth =
    auto === null ? null : listOverride === null ? auto : diffListWidthAfterDrag(inner, listOverride);
  const metrics = useRef({ pane: 0, list: 0 });
  metrics.current = { pane: inner, list: auto ?? 0 };
  const sourceFor = (path: string) => (doc.loadFull ? (doc.sources[path] ?? null) : null);

  return (
    <div
      ref={frameRef}
      className="flex h-full min-h-0 min-w-0 overflow-hidden"
      data-diff-view
      data-diff-list={listWidth === null ? "hidden" : "visible"}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <DiffToolbar
          scope={doc.scope}
          scopes={doc.scopes}
          onScope={doc.setScope}
          added={doc.added}
          removed={doc.removed}
          expanded={doc.expanded}
          onToggleExpanded={() => doc.setExpanded((value) => !value)}
          unified={doc.unified}
          onToggleUnified={() => doc.setUnified((value) => !value)}
          onJump={doc.jump}
          onHide={doc.hideActive}
          loadFull={doc.loadFull}
          onToggleLoadFull={() => doc.setLoadFull((value) => !value)}
          renderPreview={doc.renderPreview}
          onToggleRenderPreview={() => doc.setRenderPreview((value) => !value)}
          wordDiff={doc.wordDiff}
          onToggleWordDiff={() => doc.setWordDiff((value) => !value)}
          hideWs={doc.hideWs}
          onToggleHideWs={() => doc.setHideWs((value) => !value)}
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          {doc.loading ? <p className="px-4 py-6 text-sm text-zinc-500">正在读取…</p> : null}
          {doc.gitError ? <p className="px-4 py-6 text-sm text-red-300">{doc.gitError}</p> : null}
          {!doc.loading && !doc.gitError && doc.shown.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-500">{DESKTOP_ZH.noFileChanges}</p>
          ) : null}
          {doc.shown.map((file) => (
            <DiffFileSection
              key={file.path}
              file={file}
              expanded={doc.expanded}
              unified={doc.unified}
              wordDiff={doc.wordDiff}
              renderPreview={doc.renderPreview}
              source={sourceFor(file.path)}
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
            setListOverride((prev) => {
              const current = prev ?? metrics.current.list;
              return diffListWidthAfterDrag(metrics.current.pane, current - dx) ?? prev ?? current;
            });
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
          onSelect={doc.selectFile}
          onJump={() => {
            if (doc.active) doc.selectFile(doc.active);
          }}
          onRefresh={() => {
            setFileFilter("");
            setEpoch((value) => value + 1);
            doc.reload();
          }}
          onOpenExternal={() => {
            if (!doc.active) return;
            return backend.openProjectFile(projectId, doc.active.path);
          }}
          onHide={toggleFilesSidebar}
          empty={
            <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">{DESKTOP_ZH.noFileChanges}</p>
          }
        />
      ) : null}
    </div>
  );
}
