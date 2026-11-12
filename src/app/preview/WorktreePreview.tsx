import type { ReactNode } from "react";

import {
  GitBranchChrome,
  worktreeBranchMarker,
  WorktreeSessionLabel,
  WorktreeToggle,
} from "@/features/chat";
import { DeleteSessionDialog } from "@/features/sidebar";

/**
 * 开发预览。`?preview=worktree`。
 * `scene=live` 只看运行中的分支标记，`scene=delete` 只看删除确认。
 */
export default function WorktreePreview() {
  const scene = new URLSearchParams(window.location.search).get("scene");
  if (scene === "live") return <LiveMarker />;
  if (scene === "delete") return <DirtyDelete />;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-16 bg-wb-surface px-6 text-wb-fg">
      <section data-worktree-preview="shown" className="w-full max-w-[760px]">
        <ComposerShell>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-wb-border px-2.5 py-1.5" data-composer-context>
            <WorktreeToggle pressed onToggle={() => undefined} />
            <GitBranchChrome
              label="main"
              projectName="demo"
              current="main"
              branches={["main"]}
              dirtyFiles={null}
              listError={null}
              onCheckout={async () => undefined}
              onCreate={async () => undefined}
            />
          </div>
        </ComposerShell>
      </section>
      <section data-worktree-preview="hidden" className="w-full max-w-[760px]">
        <ComposerShell>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-wb-border px-2.5 py-1.5" data-composer-context>
            <span className="inline-flex h-6 items-center rounded-md border border-wb-border bg-wb-surface/75 px-2 text-xs text-wb-fg-2">
              聊天
            </span>
          </div>
        </ComposerShell>
      </section>
      <section data-worktree-preview="live" className="w-full max-w-[760px]">
        <LiveComposer />
      </section>
    </div>
  );
}

function LiveMarker() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-wb-surface px-6 text-wb-fg">
      <section data-worktree-preview="live" className="w-full max-w-[760px]">
        <LiveComposer />
      </section>
    </div>
  );
}

function LiveComposer() {
  const label =
    worktreeBranchMarker({ liveBranch: null, base: "main", sha: "abcdef1234567890" }) ?? "main";
  return (
    <ComposerShell>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-wb-border px-2.5 py-1.5" data-composer-context>
        <WorktreeSessionLabel label="工作树 a1b2/示例" title="/tmp/codex/worktrees/a1b2/示例" />
        <GitBranchChrome
          label={label}
          projectName="demo"
          current={null}
          branches={["main"]}
          dirtyFiles={null}
          listError={null}
          onCheckout={async () => undefined}
          onCreate={async () => undefined}
        />
      </div>
    </ComposerShell>
  );
}

function DirtyDelete() {
  return (
    <div className="min-h-screen bg-wb-surface text-wb-fg" data-worktree-preview="delete">
      <DeleteSessionDialog
        open
        dirtyWorktree
        error={null}
        onOpenChange={() => undefined}
        onDelete={() => undefined}
        onKeepWorktree={() => undefined}
        onDiscardWorktree={() => undefined}
      />
    </div>
  );
}

function ComposerShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl border border-wb-border-strong bg-wb-composer shadow-[var(--wb-composer-shadow)]">
      {children}
      <div className="px-3.5 py-3 text-sm text-wb-fg-3">
        输入任务或问题，@ 引用文件
      </div>
    </div>
  );
}
