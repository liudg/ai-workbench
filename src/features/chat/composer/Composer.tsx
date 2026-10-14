import { cn } from "@/lib/utils";
import type { Session, SessionEvent } from "@/types";
import { AccessMenu } from "./AccessMenu";
import { AttachMenu } from "./AttachMenu";
import { Attachments } from "./Attachments";
import { ComposerBar } from "./ComposerBar";
import { ComposerInput } from "./ComposerInput";
import { ModelMenu } from "./ModelMenu";
import { Queue } from "./Queue";
import { ReviewMenu } from "./ReviewMenu";
import { MentionMenu } from "./MentionMenu";
import { SkillMenu } from "./SkillMenu";
import { SlashMenu } from "./SlashMenu";
import { useComposerController } from "./useComposerController";

export function Composer({ session, events }: { session: Session; events: SessionEvent[] }) {
  const c = useComposerController(session, events);
  const view = c.view;
  const slashSelected = Math.min(c.slashIndex, Math.max(view.slashMatches.length - 1, 0));
  return (
    <div className="composer-root min-w-0 shrink-0 px-4 pb-4 pt-1">
      {view.occupied && (
        <p className="mx-auto mb-2 max-w-3xl break-words px-2 text-center text-xs leading-5 text-amber-200/90">
          此会话正被其他进程占用，当前只读，不能发送。
        </p>
      )}
      {c.notice && (
        <p role="status" className="mx-auto mb-2 max-w-3xl break-words px-2 text-center text-xs leading-5 text-amber-200/90">
          {c.notice}
        </p>
      )}
      {c.catalogNotice && (
        <p role="status" className="mx-auto mb-2 max-w-3xl break-words px-2 text-center text-xs leading-5 text-zinc-500">
          {c.catalogNotice}
        </p>
      )}
      <div ref={c.reviewRootRef} className="relative mx-auto min-w-0 max-w-3xl">
        {view.queueOn && (
          <Queue items={c.queue} editingId={c.editingId} onEdit={c.beginEdit} onRemove={c.removeQueued} />
        )}
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
        <div
          className={cn(
            "min-w-0 rounded-[28px] border border-zinc-700/90 bg-zinc-900 shadow-lg shadow-black/20 transition-colors focus-within:border-zinc-500",
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
          <div className="min-w-0 overflow-hidden px-3 pt-3">
          {view.goalStatus || view.contextUsage ? (
            <div className="mb-1 flex min-w-0 items-center gap-3 px-1">
              {view.goalStatus ? (
                <p data-goal-status title={view.goalStatus} className="min-w-0 truncate text-xs leading-5 text-fuchsia-300">
                  {view.goalStatus}
                </p>
              ) : null}
              {view.contextUsage ? (
                <p data-context-usage title={view.contextUsage} className="min-w-0 truncate text-xs leading-5 text-zinc-400">
                  {view.contextUsage}
                </p>
              ) : null}
            </div>
          ) : null}
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
            planChip={view.planOn}
            goalChip={view.goalOn}
            showModel={view.showModel}
            hasCatalog={c.hasCatalog}
            modelButton={view.modelButton}
            editing={Boolean(c.editingId)}
            stopMode={view.stopMode}
            sendDisabled={view.sendDisabled}
            onToggleMenu={(name) => c.setMenu((current) => (current === name ? null : name))}
            onPickFiles={() => void c.pickFiles()}
            onDismissPlan={c.dismissPlan}
            onDismissGoal={c.dismissGoal}
            onCancelEdit={c.cancelEdit}
            onSend={() => {
              if (view.stopMode) c.interrupt();
              else c.submit();
            }}
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
