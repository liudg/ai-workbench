import type { ReactNode } from "react";

import { GitBranchChrome } from "@/features/chat/composer/GitBranchControl";
import { worktreeBranchMarker } from "@/features/chat/composer/worktree-option";
import { WorktreeSessionLabel, WorktreeToggle } from "@/features/chat/composer/WorktreeChoice";
import { DeleteSessionDialog } from "@/features/sidebar/sessions/DeleteSessionDialog";

/**
 * 开发预览。`?preview=worktree`。
 * `scene=live` 只看运行中的分支标记，`scene=delete` 只看删除确认。
 */
export default function WorktreePreview() {
  const scene = new URLSearchParams(window.location.search).get("scene");
  if (scene === "live") return <LiveMarker />;
  if (scene === "delete") return <DirtyDelete />;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-16 bg-[var(--wb-canvas)] px-6 text-[var(--wb-text)]">
      <section data-worktree-preview="shown" className="w-full max-w-[760px]">
        <ComposerShell>
          <div className="mb-2 flex min-w-0 items-center gap-2 px-1" data-composer-context>
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
          <div className="mb-2 flex min-w-0 items-center gap-2 px-1" data-composer-context>
            <span className="inline-flex items-center rounded-[10px] border border-[var(--wb-border-strong)] bg-[var(--wb-card)] px-2.5 py-1 text-[13px] text-[var(--wb-text-strong)]">
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
    <div className="flex min-h-screen items-center justify-center bg-[var(--wb-canvas)] px-6 text-[var(--wb-text)]">
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
      <div className="mb-2 flex min-w-0 items-center gap-2 px-1" data-composer-context>
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
    <div className="min-h-screen bg-[var(--wb-canvas)] text-[var(--wb-text)]" data-worktree-preview="delete">
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
    <div>
      {children}
      <div className="min-w-0 rounded-[18px] border border-[var(--wb-border-strong)] bg-[var(--wb-composer)] px-3 py-3 text-sm text-[var(--wb-faint)] shadow-[var(--wb-composer-shadow)]">
        输入消息…
      </div>
    </div>
  );
}
