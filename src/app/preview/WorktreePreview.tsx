import type { ReactNode } from "react";

import { GitBranchChrome } from "@/features/chat/composer/GitBranchControl";
import { WorktreeSessionLabel, WorktreeToggle } from "@/features/chat/composer/WorktreeChoice";

/**
 * 开发预览。`?preview=worktree`。
 * 上面是有提交的 Git 项目草稿，下面是独立聊天。
 */
export default function WorktreePreview() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-16 bg-[#0f0f0f] px-6 text-[#e8e8e8]">
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
            <span className="inline-flex items-center rounded-[10px] border border-[#2e2e33] px-2.5 py-1 text-[13px] text-[#ececef]">
              聊天
            </span>
          </div>
        </ComposerShell>
      </section>
      <section data-worktree-preview="live" className="w-full max-w-[760px]">
        <ComposerShell>
          <div className="mb-2 flex min-w-0 items-center gap-2 px-1" data-composer-context>
            <WorktreeSessionLabel label="工作树 a1b2/demo" title="/tmp/codex/worktrees/a1b2/demo" />
            <GitBranchChrome
              label="HEAD"
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
      </section>
    </div>
  );
}

function ComposerShell({ children }: { children: ReactNode }) {
  return (
    <div>
      {children}
      <div className="min-w-0 rounded-[18px] border border-[#2a2a2a] bg-[#171717] px-3 py-3 text-sm text-[#8a8a8a]">
        输入消息…
      </div>
    </div>
  );
}
