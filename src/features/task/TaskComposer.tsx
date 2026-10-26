import type { Ref } from "react";
import { FolderGit2, GitBranch } from "lucide-react";

import { AccessMenu } from "@/features/chat/composer/AccessMenu";
import { AttachMenu } from "@/features/chat/composer/AttachMenu";
import { Attachments } from "@/features/chat/composer/Attachments";
import { ComposerBar } from "@/features/chat/composer/ComposerBar";
import { ComposerInput } from "@/features/chat/composer/ComposerInput";
import { runComposerPrimary } from "@/features/chat/composer/composer-view";
import { ModelMenu } from "@/features/chat/composer/ModelMenu";
import { ReviewMenu } from "@/features/chat/composer/ReviewMenu";
import type { TaskWorkspace } from "@/features/tasks";
import { cn } from "@/lib/utils";
import { QueuedMessageList } from "@/features/chat/composer/QueueStrip";
import { queueStripVisible } from "@/features/chat/composer/queue-strip";
import { SlashMenu } from "@/features/chat/composer/SlashMenu";
import { TextSnippetChip, TextSnippetPreview } from "@/features/chat/composer/TextSnippets";
import { reviewTargets } from "./task-backend";
import type { TaskComposerController } from "./use-task-composer";

export function TaskComposer({
  c,
  sessionId,
  workspace,
  anchorRef,
}: {
  c: TaskComposerController;
  sessionId: string;
  workspace: TaskWorkspace;
  anchorRef?: Ref<HTMLDivElement>;
}) {
  const view = c.view;
  const slashSelected = Math.min(c.slashIndex, Math.max(view.slashMatches.length - 1, 0));
  const showQueue = queueStripVisible({ supportsQueue: view.queueOn, count: c.queue.length });
  return (
    <div className="composer-root relative z-10 min-w-0 shrink-0 px-4 pb-4 pt-1">
      {view.occupied && (
        <p className="mb-2 break-words px-2 text-center text-xs leading-5 text-amber-200/90">
          此会话正被其他进程占用，当前只读，不能发送。
        </p>
      )}
      {c.notice && (
        <p role="status" className="mb-2 break-words px-2 text-center text-xs leading-5 text-amber-200/90">
          {c.notice}
        </p>
      )}
      {c.catalogNotice && (
        <p role="status" className="mb-2 break-words px-2 text-center text-xs leading-5 text-[#888]">
          {c.catalogNotice}
        </p>
      )}
      <div ref={c.reviewRootRef} className="relative min-w-0">
        {c.reviewOpen && <ReviewMenu sessionId={sessionId} loadTargets={reviewTargets} onStart={c.startReview} />}
        {view.slashOpen && !c.reviewOpen && (
          <SlashMenu
            matches={view.slashMatches}
            selected={view.slashMatches.length === 0 ? -1 : slashSelected}
            token={view.token}
            planOn={view.planOn}
            onPick={c.applySlash}
          />
        )}
        <WorkspaceLine workspace={workspace} />
        <TextSnippetPreview snippets={c.snippets} />
        <div
          ref={anchorRef}
          data-question-anchor
          className={cn(
            "min-w-0 rounded-[18px] border border-[#2a2a2a] bg-[#171717] transition-colors focus-within:border-[#3a3a3a]",
            c.dragOver && view.imagesOn && "border-indigo-400/80",
          )}
          onClick={() => c.textareaRef.current?.focus()}
          {...c.dropTarget}
        >
          {showQueue ? (
            <QueuedMessageList
              items={c.queue}
              mode={c.followUpQueueMode}
              editingId={c.editingId}
              onSteer={c.steerQueued}
              onRemove={c.removeQueued}
              onEdit={c.beginEdit}
              onToggleQueueMode={c.toggleQueueMode}
            />
          ) : null}
          <div className="min-w-0 overflow-hidden px-3 pt-3">
            <TextSnippetChip snippets={c.snippets} onClear={c.dismissSnippets} />
            <Attachments files={c.files} imagesOn={view.imagesOn} onRemove={c.removeFile} />
            <ComposerInput
              text={c.text}
              placeholder={view.placeholder}
              disabled={view.composerLocked}
              textareaRef={c.textareaRef}
              onChange={(value, element) => {
                c.setText(value);
                c.rememberCaret(element);
              }}
              onCaret={c.rememberCaret}
              onPaste={c.onPaste}
              onKeyDown={c.onKeyDown}
            />
          </div>
          <div className="px-3 pb-2.5">
            <ComposerBar
              plusRef={c.plusRef}
              accessRef={c.accessRef}
              modelRef={c.modelRef}
              menu={c.menu}
              imagesOn={view.imagesOn}
              composerLocked={view.composerLocked}
              sandbox={c.sandbox}
              permissionMenu={view.permissionMenu}
              planIndicator={view.planIndicator}
              goalChip={false}
              showModel={view.showModel}
              hasCatalog={c.hasCatalog}
              modelButton={view.modelButton}
              modelName={view.modelName}
              effortLabel={view.effortLabel}
              editing={Boolean(c.editingId)}
              stopMode={view.stopMode}
              sendDisabled={view.sendDisabled}
              onToggleMenu={(name) => c.setMenu((current) => (current === name ? null : name))}
              onPickFiles={() => void c.pickFiles()}
              onDismissPlan={c.dismissPlan}
              onDismissGoal={() => {}}
              onCancelEdit={c.cancelEdit}
              onSend={() => runComposerPrimary(view.stopMode, { interrupt: c.interrupt, submit: c.submit })}
            />
          </div>
        </div>
      </div>
      {c.menu === "attach" && view.imagesOn && (
        <AttachMenu menuRef={c.attachMenuRef} onPick={() => void c.pickFiles()} />
      )}
      {c.menu === "access" && (
        <AccessMenu
          menuRef={c.accessMenuRef}
          sandbox={c.sandbox}
          menu={view.permissionMenu}
          showNetwork={view.showNetwork}
          showWritable={view.showWritable}
          onPreset={c.selectPreset}
          onProfile={c.selectProfile}
          onNetwork={c.setNetwork}
          onAddDir={() => void c.addDir()}
          onRemoveDir={c.removeDir}
        />
      )}
      {c.menu === "model" && view.showModel && (
        <ModelMenu
          menuRef={c.modelMenuRef}
          models={c.models}
          modelId={view.selectedModel?.id}
          modelLabel={view.selectedModel?.label}
          effortId={view.selectedEffort}
          fastOn={view.fastOn}
          fastAvailable={view.fastAvailable}
          fastTip={view.fastTip}
          canReset={Boolean(view.baselineModelId)}
          onModel={c.chooseModel}
          onEffort={c.chooseEffort}
          onFast={c.chooseFast}
          onReset={c.resetTuning}
        />
      )}
    </div>
  );
}

/** 这个任务在哪干活：工作树分支或主目录。 */
function WorkspaceLine({ workspace }: { workspace: TaskWorkspace }) {
  const worktree = workspace.kind === "worktree";
  return (
    <div className="mb-1.5 flex min-w-0 items-center gap-1 px-2 text-[12px] text-[#777]" data-task-workspace>
      {worktree ? <GitBranch className="h-3.5 w-3.5 shrink-0" /> : <FolderGit2 className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate" title={worktree ? workspace.path : undefined}>
        {worktree ? workspace.branch : "主目录"}
      </span>
    </div>
  );
}
