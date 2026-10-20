import type { Ref } from "react";

import { userFacingMessage } from "@/lib/user-facing";
import { cn } from "@/lib/utils";
import type { Session, SessionEvent } from "@/types";
import { AccessMenu } from "./AccessMenu";
import { AttachMenu } from "./AttachMenu";
import { Attachments } from "./Attachments";
import { ComposerBar } from "./ComposerBar";
import { ComposerInput } from "./ComposerInput";
import { TextSnippetChip, TextSnippetPreview } from "./TextSnippets";
import { ModelMenu } from "./ModelMenu";
import { QueuedMessageList } from "./QueueStrip";
import { ReviewMenu } from "./ReviewMenu";
import { MentionMenu } from "./MentionMenu";
import { SkillMenu } from "./SkillMenu";
import { SlashMenu } from "./SlashMenu";
import { GoalStatusBar } from "./GoalStatusBar";
import { runComposerPrimary } from "./composer-view";
import { useComposerController } from "./useComposerController";
import { ComposerContextRow } from "./GitBranchControl";
import { useSessionWorktree } from "./use-session-worktree";

export function Composer({
  session,
  events,
  anchorRef,
}: {
  session: Session;
  events: SessionEvent[];
  anchorRef?: Ref<HTMLDivElement>;
}) {
  const c = useComposerController(session, events);
  const worktree = useSessionWorktree(session);
  const view = c.view;
  const notice = userFacingMessage(c.notice);
  const catalogNotice = userFacingMessage(c.catalogNotice);
  const slashSelected = Math.min(c.slashIndex, Math.max(view.slashMatches.length - 1, 0));
  return (
    <div className="composer-root relative z-10 min-w-0 shrink-0 px-4 pb-4 pt-1">
      {view.occupied && (
        <p className="mb-2 break-words px-2 text-center text-xs leading-5 text-amber-200/90">
          此会话正被其他进程占用，当前只读，不能发送。
        </p>
      )}
      {notice && (
        <p role="status" className="mb-2 break-words px-2 text-center text-xs leading-5 text-amber-200/90">
          {notice}
        </p>
      )}
      {catalogNotice && (
        <p role="status" className="mb-2 break-words px-2 text-center text-xs leading-5 text-[#888]">
          {catalogNotice}
        </p>
      )}
      <div ref={c.reviewRootRef} className="relative min-w-0">
        {c.mentions.show && (
          <MentionMenu
            mode={view.mentionAdd ? "add" : "files"}
            active={c.mentions.index}
            goalSupport={c.goalSupport}
            planSupport={view.planSupport}
            goalNotice={c.goalNotice}
            files={c.mentions.hits}
            pending={c.mentions.pending}
            error={c.mentions.error}
            query={view.mentionQuery ?? ""}
            onPick={c.mentions.pick}
          />
        )}
        {view.skillOpen && (
          <SkillMenu
            matches={view.skillMatches}
            active={c.activeSkill}
            hasCatalog={c.hasCatalog}
            skillsError={c.skillsError}
            listedCount={c.skillCount}
            onPick={c.applySkill}
          />
        )}
        {c.reviewOpen && <ReviewMenu sessionId={session.id} onStart={c.startReview} />}
        {view.slashOpen && !c.reviewOpen && (
          <SlashMenu
            matches={view.slashMatches}
            selected={view.slashMatches.length === 0 ? -1 : slashSelected}
            token={view.token}
            planOn={view.planOn}
            onPick={c.applySlash}
          />
        )}
        {view.goalStatus ? (
          <GoalStatusBar
            model={view.goalStatus}
            disabled={view.occupied || view.dead}
            onDelete={c.deleteGoal}
            onToggleRun={c.toggleGoalRun}
            onEdit={c.editGoal}
          />
        ) : null}
        <ComposerContextRow
          workContext={c.workContext}
          projectId={c.gitProject?.id ?? ""}
          projectName={c.gitProject?.name ?? ""}
          sessionId={session.id}
          worktree={worktree}
        />
        <TextSnippetPreview snippets={c.snippets} />
        <div
          ref={anchorRef}
          data-question-anchor
          className={cn(
            "min-w-0 rounded-[18px] border border-[#2a2a2a] bg-[#171717] transition-colors focus-within:border-[#3a3a3a]",
            c.dragOver && view.imagesOn && "border-indigo-400/80",
          )}
          onClick={() => c.textareaRef.current?.focus()}
          onDragOver={(event) => {
            if (!view.imagesOn || view.composerLocked) return;
            event.preventDefault();
            c.setDragOver(true);
          }}
          onDragLeave={() => c.setDragOver(false)}
          onDrop={(event) => {
            if (!view.imagesOn || view.composerLocked) return;
            event.preventDefault();
            c.setDragOver(false);
            void c.stageBlobs(Array.from(event.dataTransfer.files));
          }}
        >
          {c.queueStrip ? (
            <QueuedMessageList
              items={c.queue}
              mode={c.followUpQueueMode}
              editingId={c.editingId}
              canOpenSideChat={false}
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
            goalChip={view.goalChip}
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
            onDismissGoal={c.dismissGoal}
            onCancelEdit={c.cancelEdit}
            onSend={() =>
              runComposerPrimary(view.stopMode, {
                interrupt: () => c.interrupt(),
                submit: () => c.submit(),
              })
            }
          />
          </div>
        </div>
      </div>
      {c.menu === "attach" && view.imagesOn && <AttachMenu menuRef={c.attachMenuRef} onPick={() => void c.pickFiles()} />}
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
          onAddDir={c.addDir}
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
