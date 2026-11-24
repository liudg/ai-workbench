import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { tasksApi } from "@/features/tasks";
import { userFacingMessage } from "@/lib/user-facing";
import { useNavigation } from "@/shared/shell/navigation";

import { branchNameError } from "./git-branch";

/** 起一个分支名：新建分支、交给项目目录前给工作树起分支都用这个。 */
export function BranchNameDialog({
  open,
  title,
  description,
  initialName,
  submitLabel,
  busyLabel,
  busy,
  error,
  onCancel,
  onSubmit,
  onSuggestBranch,
  dataAttr,
}: {
  open: boolean;
  title: string;
  /** 没有时只给读屏用。 */
  description?: string;
  initialName: string;
  submitLabel: string;
  busyLabel: string;
  busy: boolean;
  /** 提交失败时外面传进来的错误。 */
  error: string | null;
  onCancel: () => void;
  onSubmit: (name: string) => void;
  /** 可选自定义 AI 分支名生成；为 `null` 时隐藏按钮，缺省按当前视图调用 `tasksApi.generateBranchName`。 */
  onSuggestBranch?: ((currentName: string) => Promise<string>) | null;
  dataAttr: string;
}) {
  const inputId = useId();
  const navView = useNavigation((state) => state.view);
  const [name, setName] = useState(initialName);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const lastSuggestedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      setSuggesting(false);
      lastSuggestedRef.current = null;
      return;
    }
    setName(initialName);
    setInvalid(null);
    setSuggesting(false);
    lastSuggestedRef.current = null;
  }, [open, initialName]);

  const suggest = async () => {
    if (busy || suggesting || onSuggestBranch === null) return;
    setSuggesting(true);
    setInvalid(null);
    try {
      let generated: string;
      if (onSuggestBranch) {
        generated = await onSuggestBranch(name);
      } else {
        const taskId = navView.kind === "task" ? navView.taskId : undefined;
        const projectId = navView.kind !== "none" ? navView.projectId : null;
        const trimmedCurrent = name.trim();
        const isUneditedInitial = trimmedCurrent === initialName.trim();
        const isUneditedSuggestion =
          lastSuggestedRef.current !== null && trimmedCurrent === lastSuggestedRef.current;
        const edited = !isUneditedInitial && !isUneditedSuggestion ? trimmedCurrent : "";
        const composerHint =
          typeof document !== "undefined"
            ? (document.querySelector<HTMLTextAreaElement>("[data-composer-column] textarea")?.value ?? "").trim()
            : "";
        const prompt = edited || composerHint;
        const res = await tasksApi.generateBranchName({ taskId, projectId, prompt });
        generated = res.branch;
      }
      const trimmed = generated.trim();
      if (!trimmed) {
        setInvalid("未能生成分支名，请手动输入");
      } else {
        lastSuggestedRef.current = trimmed;
        setName(trimmed);
      }
    } catch (err: unknown) {
      setInvalid(userFacingMessage(err) ?? "无法生成分支名");
    } finally {
      setSuggesting(false);
    }
  };

  const submit = () => {
    const failure = branchNameError(name);
    if (failure) {
      setInvalid(failure);
      return;
    }
    onSubmit(name.trim());
  };
  const shown = invalid ?? error;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy || suggesting) return;
        if (!next) onCancel();
      }}
    >
      <DialogContent {...{ [dataAttr]: "" }}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={description ? undefined : "sr-only"}>
            {description ?? "输入分支名"}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={inputId} className="text-sm text-wb-fg-2">
                分支名
              </label>
              {onSuggestBranch !== null ? (
                <button
                  type="button"
                  data-branch-ai-suggest=""
                  disabled={busy || suggesting}
                  onClick={() => void suggest()}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-wb-border bg-wb-elev px-2 text-xs font-medium text-wb-fg-2 transition-colors hover:border-wb-border-strong hover:bg-wb-hover hover:text-wb-fg disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {suggesting ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-wb-accent" />
                  ) : (
                    <Sparkles className="h-3 w-3 shrink-0 text-wb-accent-ink" />
                  )}
                  <span>{suggesting ? "正在生成…" : "AI 生成"}</span>
                </button>
              ) : null}
            </div>
            <Input
              id={inputId}
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (invalid) setInvalid(null);
              }}
            />
          </div>
          {shown ? (
            <p role="alert" className="text-xs text-wb-danger">
              {shown}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy || suggesting} onClick={onCancel}>
              取消
            </Button>
            <Button type="submit" disabled={busy || suggesting}>
              {busy ? busyLabel : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
