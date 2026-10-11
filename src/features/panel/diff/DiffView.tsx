import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { FileChange } from "@/features/changes-model/diff-parse";
import { FileList } from "@/features/panel/files/FileList";
import { DiffFileSection } from "./DiffFileSection";
import { DiffToolbar } from "./DiffToolbar";
import { useDiffDocument } from "./useDiffDocument";

export function DiffView({ files }: { files: FileChange[] }) {
  const doc = useDiffDocument(files);
  const sourceFor = (path: string) => (doc.loadFull ? (doc.sources[path] ?? null) : null);
  return (
    <div className="@container/diff flex h-full min-h-0 min-w-0" data-diff-view>
      <div className="flex min-w-0 flex-1 flex-col">
        <DiffToolbar
          scope={doc.scope}
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
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
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
      <aside className="flex w-[4.75rem] shrink-0 flex-col border-l border-zinc-800 @[26rem]/diff:w-52">
        <FileList
          files={doc.shown}
          activePath={doc.active?.path ?? ""}
          rowAttr="data-diff-file"
          filterAttr="data-diff-filter"
          onSelect={doc.selectFile}
          empty={null}
        />
      </aside>
    </div>
  );
}
