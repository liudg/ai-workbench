import { useRef } from "react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { useElementWidth } from "@/shared/dom/useElementWidth";
import type { FileChange } from "@/features/changes-model/diff-parse";
import { diffListWidth } from "../core/layout";
import { FileList } from "@/features/panel/files/FileList";
import { DiffFileSection } from "./DiffFileSection";
import { DiffToolbar } from "./DiffToolbar";
import { useDiffDocument } from "./useDiffDocument";

export function DiffView({ files }: { files: FileChange[] }) {
  const doc = useDiffDocument(files);
  const frameRef = useRef<HTMLDivElement>(null);
  const listWidth = diffListWidth(useElementWidth(frameRef));
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
        <aside
          data-diff-files
          style={{ width: listWidth, minWidth: listWidth }}
          className="flex shrink-0 flex-col overflow-hidden border-l border-zinc-800"
        >
          <FileList
            files={doc.shown}
            activePath={doc.active?.path ?? ""}
            rowAttr="data-diff-file"
            filterAttr="data-diff-filter"
            onSelect={doc.selectFile}
            empty={null}
          />
        </aside>
      ) : null}
    </div>
  );
}
