import {
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Rocket,
  XCircle,
} from "lucide-react";

import { APP_VERSION } from "@/lib/version";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpdateDialog } from "./use-update-dialog";

function formatSize(bytes: number) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function UpdateDialog() {
  const { open, update, close, startInstall } = useUpdateDialog();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>检查更新</DialogTitle>
          <DialogDescription>当前版本 v{APP_VERSION}</DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-3 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-well)] px-4 py-3.5">
          {update.kind === "checking" && (
            <>
              <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-[var(--wb-muted)]" />
              <p className="text-sm text-[var(--wb-text)]">正在检查更新…</p>
            </>
          )}
          {update.kind === "none" && (
            <>
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--wb-success-strong)]" />
              <p className="text-sm text-[var(--wb-text)]">已是最新版本。</p>
            </>
          )}
          {update.kind === "available" && (
            <>
              <Rocket className="mt-0.5 h-5 w-5 shrink-0 text-[var(--wb-accent)]" />
              <div className="min-w-0">
                <p className="text-sm text-[var(--wb-text-strong)]">
                  发现新版本 <span className="font-medium">v{update.version}</span>
                </p>
                {update.notes && (
                  <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-[var(--wb-muted)]">
                    {update.notes}
                  </p>
                )}
              </div>
            </>
          )}
          {update.kind === "downloading" && (
            <>
              <Download className="mt-0.5 h-5 w-5 shrink-0 animate-pulse text-[var(--wb-accent)]" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-[var(--wb-text)]">正在下载更新…</p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--wb-chip)]">
                  <div
                    className="h-full rounded-full bg-[var(--wb-accent)] transition-all"
                    style={{
                      width: update.total
                        ? `${Math.min(100, (update.received / update.total) * 100)}%`
                        : "40%",
                    }}
                  />
                </div>
                <p className="mt-1 text-[11px] tabular-nums text-[var(--wb-muted)]">
                  {formatSize(update.received)}
                  {update.total ? ` / ${formatSize(update.total)}` : ""}
                </p>
              </div>
            </>
          )}
          {update.kind === "ready" && (
            <>
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--wb-success-strong)]" />
              <p className="text-sm text-[var(--wb-text)]">
                v{update.version} 安装完成，应用即将重启…
              </p>
            </>
          )}
          {update.kind === "unavailable" && (
            <>
              <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-[var(--wb-muted)]" />
              <p className="text-sm text-[var(--wb-text)]">暂无可用更新源</p>
            </>
          )}
          {update.kind === "error" && (
            <>
              <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--wb-danger-strong)]" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--wb-text-strong)]">检查更新失败</p>
                <p className="mt-1 break-all text-xs leading-5 text-[var(--wb-danger-text)]">
                  {update.message}
                </p>
              </div>
            </>
          )}
          {update.kind === "idle" && (
            <>
              <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-[var(--wb-muted)]" />
              <p className="text-sm text-[var(--wb-muted)]">点击「检查更新」获取新版本。</p>
            </>
          )}
        </div>

        <DialogFooter>
          {update.kind === "available" ? (
            <>
              <Button variant="ghost" onClick={close}>
                稍后
              </Button>
              <Button onClick={startInstall}>
                <Download /> 立即更新
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={close}>
              关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
