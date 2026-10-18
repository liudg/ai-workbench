import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function DeleteSessionDialog({
  open,
  dirtyWorktree,
  error,
  onOpenChange,
  onDelete,
  onKeepWorktree,
  onDiscardWorktree,
}: {
  open: boolean;
  dirtyWorktree: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
  onKeepWorktree: () => void;
  onDiscardWorktree: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-delete-session={dirtyWorktree ? "dirty-worktree" : "session"}>
        <DialogHeader>
          <DialogTitle>要删除任务？</DialogTitle>
          <DialogDescription>
            {dirtyWorktree
              ? "工作树里还有未保存的改动。可以连工作树一起删除，或只删除任务、留下工作树。"
              : "这将永久删除该任务及其子智能体任务。此操作无法撤销。"}
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-red-300">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" autoFocus onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {dirtyWorktree ? (
            <Button variant="outline" onClick={onKeepWorktree}>
              保留工作树
            </Button>
          ) : null}
          <Button variant="destructive" onClick={dirtyWorktree ? onDiscardWorktree : onDelete}>
            {dirtyWorktree ? "一起删除" : "删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
