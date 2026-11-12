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
          <DialogTitle>删除任务</DialogTitle>
          <DialogDescription>
            {dirtyWorktree
              ? "工作树内有未提交改动。可保留工作树仅删除任务，或一并删除。"
              : "删除后将一并移除其子任务，不可恢复。"}
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-xs text-wb-danger">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {dirtyWorktree ? (
            <Button variant="secondary" onClick={onKeepWorktree}>
              保留工作树
            </Button>
          ) : null}
          <Button variant="destructive" onClick={dirtyWorktree ? onDiscardWorktree : onDelete}>
            {dirtyWorktree ? "一并删除" : "删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
