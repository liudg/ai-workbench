import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, MessageSquare, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { tasksApi, type RewindPreview, type RewindResult } from "@/features/tasks";
import { userFacingMessage } from "@/lib/user-facing";
import { cn } from "@/lib/utils";
import type { Attachment } from "@/types";

import { parseRewoundDraft } from "./restore-draft";

export type RewindMode = "both" | "conversation";

export interface RewindCompletion {
  activeSessionId: string;
  text: string;
  files: Attachment[];
  filesRestored: boolean;
}

export interface RewindTarget {
  sessionId: string;
  userEventId: string;
}

export function RewindDialog({
  target,
  onCancel,
  onComplete,
  loadPreview = tasksApi.rewindPreview,
  executeRewind = tasksApi.rewindSession,
}: {
  target: RewindTarget | null;
  onCancel: () => void;
  onComplete: (result: RewindCompletion) => void;
  loadPreview?: (sessionId: string, userEventId: string) => Promise<RewindPreview>;
  executeRewind?: (
    sessionId: string,
    userEventId: string,
    restoreFiles: boolean,
  ) => Promise<RewindResult>;
}) {
  const open = target !== null;
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<RewindMode>("conversation");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const completedCloseRef = useRef(false);

  useEffect(() => {
    if (!target) {
      setPreview(null);
      setLoading(false);
      setLoadError(null);
      setSubmitting(false);
      setSubmitError(null);
      return;
    }
    let cancelled = false;
    completedCloseRef.current = false;
    setPreview(null);
    setLoading(true);
    setLoadError(null);
    setSubmitError(null);
    setSubmitting(false);
    void loadPreview(target.sessionId, target.userEventId)
      .then((res) => {
        if (cancelled) return;
        setPreview(res);
        setMode(res.canRestoreFiles ? "both" : "conversation");
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(userFacingMessage(error) ?? "无法加载回退预览");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadPreview, target?.sessionId, target?.userEventId]);

  const restoreFiles = Boolean(preview?.canRestoreFiles && mode === "both");
  const showManualWarning = Boolean(preview?.hasManualEditsWarning && restoreFiles);

  const confirm = async () => {
    if (!target || !preview || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await executeRewind(target.sessionId, target.userEventId, restoreFiles);
      const draft = parseRewoundDraft(result.restoredText, result.restoredImages);
      completedCloseRef.current = true;
      onComplete({
        activeSessionId: result.activeSessionId,
        text: draft.text,
        files: draft.files,
        filesRestored: result.filesRestored,
      });
    } catch (error: unknown) {
      setSubmitError(userFacingMessage(error) ?? "回退失败");
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        if (!next) onCancel();
      }}
    >
      <DialogContent
        data-rewind-dialog=""
        onCloseAutoFocus={(event) => {
          if (completedCloseRef.current) {
            event.preventDefault();
            completedCloseRef.current = false;
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>回退到此处</DialogTitle>
          <DialogDescription>
            {preview
              ? `将撤回 ${preview.turnsToRemove} 轮对话，选中的这条消息会放回输入框重新编辑。`
              : "正在检查可回退的对话轮次与工作区检查点…"}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div data-rewind-loading="" className="grid gap-2.5 py-2" aria-busy="true">
            <div className="h-16 animate-pulse rounded-xl border border-wb-border bg-wb-elev" />
            <div className="h-16 animate-pulse rounded-xl border border-wb-border bg-wb-elev" />
          </div>
        ) : loadError ? (
          <p role="alert" data-rewind-error="" className="rounded-xl border border-wb-danger/35 bg-wb-danger/10 px-3 py-2.5 text-xs leading-5 text-wb-danger">
            {loadError}
          </p>
        ) : preview ? (
          <div className="grid gap-2.5">
            <div role="radiogroup" aria-label="回退方式" className="grid gap-2">
              <button
                type="button"
                role="radio"
                data-rewind-mode="both"
                aria-checked={mode === "both"}
                disabled={!preview.canRestoreFiles || submitting}
                onClick={() => {
                  if (preview.canRestoreFiles) setMode("both");
                }}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wb-accent/65",
                  !preview.canRestoreFiles
                    ? "cursor-not-allowed border-wb-border bg-wb-surface/50 opacity-65"
                    : mode === "both"
                      ? "border-wb-accent bg-wb-accent-soft/45"
                      : "border-wb-border bg-wb-elev hover:border-wb-border-strong hover:bg-wb-hover",
                )}
              >
                <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-wb-fg-2" />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-sm font-medium text-wb-fg">回退对话与工作区文件</span>
                  <span
                    data-rewind-files-disabled-reason={!preview.canRestoreFiles ? "" : undefined}
                    className="text-xs leading-5 text-wb-fg-2"
                  >
                    {preview.canRestoreFiles
                      ? "同时将工作区文件恢复到发送这条消息之前的状态"
                      : (preview.fileRestoreDisabledReason?.trim() || "当前没有可用的工作区文件检查点")}
                  </span>
                </span>
              </button>

              <button
                type="button"
                role="radio"
                data-rewind-mode="conversation"
                aria-checked={mode === "conversation"}
                disabled={submitting}
                onClick={() => setMode("conversation")}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wb-accent/65",
                  mode === "conversation"
                    ? "border-wb-accent bg-wb-accent-soft/45"
                    : "border-wb-border bg-wb-elev hover:border-wb-border-strong hover:bg-wb-hover",
                )}
              >
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-wb-fg-2" />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-sm font-medium text-wb-fg">仅回退对话</span>
                  <span className="text-xs leading-5 text-wb-fg-2">
                    保留当前工作区文件不做改动，仅撤回对话历史
                  </span>
                </span>
              </button>
            </div>

            {showManualWarning ? (
              <div
                role="status"
                data-rewind-manual-warning=""
                className="flex items-start gap-2 rounded-xl border border-wb-warn/40 bg-wb-warn/10 px-3 py-2.5 text-xs leading-5 text-wb-warn"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>检测到上一轮结束后工作区还有未归属给 Agent 的手动修改，还原文件将一并覆盖这些未提交改动。</span>
              </div>
            ) : null}

            {submitError ? (
              <p role="alert" data-rewind-error="" className="text-xs text-wb-danger">
                {submitError}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
          <Button
            type="button"
            data-rewind-confirm=""
            disabled={loading || !preview || submitting}
            onClick={() => void confirm()}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                正在回退…
              </>
            ) : (
              "确认回退"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
