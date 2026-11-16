import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Rocket,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpdateDialog, useUpdateDialogOpen } from "./use-updates";

export function UpdateDialog() {
  const open = useUpdateDialogOpen();
  if (!open) return null;
  return <UpdateDialogOpen />;
}

function UpdateDialogOpen() {
  const {
    appVersion,
    update,
    progress,
    runningSessions,
    confirming,
    close,
    dismiss,
    requestDownload,
    requestInstall,
    cancelConfirm,
    confirmInstall,
    retry,
    recheck,
  } = useUpdateDialog();

  const canRecheckOnError =
    update.kind === "error" &&
    (update.stage === "download" || update.stage === "install");

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>检查更新</DialogTitle>
          <DialogDescription>当前版本 v{appVersion}</DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-3 rounded-xl border border-wb-border bg-wb-elev px-4 py-3.5">
          {update.kind === "checking" && (
            <>
              <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-wb-fg-3" />
              <p className="text-sm text-wb-fg-2">正在检查更新…</p>
            </>
          )}
          {update.kind === "none" && (
            <>
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-wb-ok" />
              <p className="text-sm text-wb-fg">当前已是最新版本。</p>
            </>
          )}
          {update.kind === "available" && (
            <>
              <Rocket className="mt-0.5 h-5 w-5 shrink-0 text-wb-accent" />
              <div className="min-w-0">
                <p className="text-sm text-wb-fg">
                  发现新版本 <span className="font-medium">v{update.version}</span>
                </p>
                {update.notes && (
                  <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-wb-fg-2">
                    {update.notes}
                  </p>
                )}
              </div>
            </>
          )}
          {update.kind === "downloading" && progress && (
            <>
              <Download className="mt-0.5 h-5 w-5 shrink-0 animate-pulse text-wb-accent" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-wb-fg-2">正在下载 v{update.version}…</p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-wb-border">
                  <div
                    className="h-full rounded-full bg-wb-accent transition-all"
                    style={{ width: progress.width }}
                  />
                </div>
                <p className="mt-1 text-xs text-wb-fg-3">{progress.text}</p>
              </div>
            </>
          )}
          {update.kind === "downloaded" && !confirming && (
            <>
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-wb-ok" />
              <div className="min-w-0">
                <p className="text-sm text-wb-fg">
                  新版本 <span className="font-medium">v{update.version}</span> 已下载就绪
                </p>
                <p className="mt-1 text-xs leading-5 text-wb-fg-2">
                  重启应用即可完成更新。
                </p>
                {update.notes && (
                  <p className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap border-t border-wb-border pt-1.5 text-xs leading-5 text-wb-fg-3">
                    {update.notes}
                  </p>
                )}
              </div>
            </>
          )}
          {update.kind === "downloaded" && confirming && (
            <>
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-wb-warn" />
              <div className="min-w-0">
                <p className="text-sm text-wb-fg">
                  还有 {runningSessions} 个会话在运行
                </p>
                <p className="mt-1 text-xs leading-5 text-wb-fg-2">
                  更新并重启应用会停掉正在运行的会话，是否继续？
                </p>
              </div>
            </>
          )}
          {update.kind === "installing" && (
            <>
              <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-wb-accent" />
              <p className="text-sm text-wb-fg">
                正在安装 v{update.version} 并重启…
              </p>
            </>
          )}
          {update.kind === "ready" && (
            <>
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-wb-ok" />
              <p className="text-sm text-wb-fg">
                v{update.version} 已就绪，正在重启…
              </p>
            </>
          )}
          {update.kind === "unavailable" && (
            <>
              <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-wb-fg-3" />
              <p className="text-sm text-wb-fg-2">暂无可用更新源</p>
            </>
          )}
          {update.kind === "error" && (
            <>
              <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-wb-danger" />
              <div className="min-w-0">
                <p className="text-sm text-wb-fg">
                  {update.stage === "check"
                    ? "检查更新失败"
                    : update.stage === "download"
                      ? "更新下载失败"
                      : update.stage === "restart"
                        ? "重启未完成"
                        : "更新未完成"}
                </p>
                <p className="mt-1 break-all text-xs leading-5 text-wb-fg-2">
                  {update.message}
                </p>
              </div>
            </>
          )}
          {update.kind === "idle" && (
            <>
              <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-wb-fg-3" />
              <p className="text-sm text-wb-fg-2">点击「检查更新」获取新版本。</p>
            </>
          )}
        </div>

        <DialogFooter>
          {update.kind === "available" ? (
            <>
              <Button variant="ghost" onClick={dismiss}>
                稍后
              </Button>
              <Button onClick={requestDownload}>
                <Download /> 下载更新
              </Button>
            </>
          ) : update.kind === "downloading" ? (
            <Button variant="ghost" onClick={close}>
              后台下载
            </Button>
          ) : update.kind === "downloaded" && confirming ? (
            <>
              <Button variant="ghost" onClick={cancelConfirm}>
                取消
              </Button>
              <Button onClick={confirmInstall}>
                <RefreshCw /> 继续更新
              </Button>
            </>
          ) : update.kind === "downloaded" ? (
            <>
              <Button variant="ghost" onClick={close}>
                稍后重启
              </Button>
              <Button onClick={requestInstall}>
                <RefreshCw /> 立即重启
              </Button>
            </>
          ) : update.kind === "error" ? (
            <>
              <Button
                variant="ghost"
                onClick={canRecheckOnError ? recheck : close}
              >
                {canRecheckOnError ? "重新检查" : "关闭"}
              </Button>
              <Button onClick={retry}>
                <RefreshCw /> 重试
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
