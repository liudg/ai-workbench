import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
  dataAttr: string;
}) {
  const [name, setName] = useState(initialName);
  const [invalid, setInvalid] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setInvalid(null);
  }, [open, initialName]);

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
        if (busy) return;
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
          <label className="grid gap-1.5 text-sm text-zinc-300">
            分支名
            <input
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (invalid) setInvalid(null);
              }}
              className="h-9 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
            />
          </label>
          {shown ? (
            <p role="alert" className="text-xs text-red-300">
              {shown}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="text-zinc-400 hover:bg-transparent hover:text-zinc-200"
              disabled={busy}
              onClick={onCancel}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-zinc-100 px-4 text-zinc-950 shadow-none hover:bg-white"
            >
              {busy ? busyLabel : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
