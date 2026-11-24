import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  getCliCommandStatus,
  installCliCommand,
  uninstallCliCommand,
  type CliCommandStatus,
} from "@/lib/native/cli-command";
import { userFacingMessage } from "@/lib/user-facing";

export function CliCommandSection() {
  const [status, setStatus] = useState<CliCommandStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justInstalled, setJustInstalled] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getCliCommandStatus();
      setStatus(next);
    } catch (err) {
      setError(userFacingMessage(err) ?? "读取命令行状态失败");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInstall = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await installCliCommand();
      setStatus(next);
      setJustInstalled(true);
    } catch (err) {
      setError(userFacingMessage(err) ?? "安装命令行工具失败");
    } finally {
      setBusy(false);
    }
  };

  const handleUninstall = async () => {
    setBusy(true);
    setError(null);
    setJustInstalled(false);
    try {
      const next = await uninstallCliCommand();
      setStatus(next);
    } catch (err) {
      setError(userFacingMessage(err) ?? "卸载命令行工具失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-settings-panel="cli-command" className="mt-10">
      <h2 className="text-base font-semibold text-wb-fg">命令行工具</h2>
      <p className="mt-1 max-w-lg text-sm leading-6 text-wb-fg-2">
        在终端运行{" "}
        <code className="rounded bg-wb-code px-1.5 py-0.5 font-mono text-xs text-wb-fg">
          aiwb .
        </code>{" "}
        或{" "}
        <code className="rounded bg-wb-code px-1.5 py-0.5 font-mono text-xs text-wb-fg">
          aiwb &lt;目录&gt;
        </code>{" "}
        快速在工作台中打开指定项目。
      </p>
      <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-wb-border bg-wb-elev px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm text-wb-fg">
            <span className="font-medium">aiwb 命令</span>
            {status?.supported ? (
              <span
                data-cli-command-status={status.installed ? "installed" : "not-installed"}
                className={status.installed ? "text-xs text-wb-ok" : "text-xs text-wb-fg-3"}
              >
                {status.installed ? "已安装" : "未安装"}
              </span>
            ) : null}
          </div>
          <div
            data-cli-command-detail=""
            title={status?.shimPath ?? ""}
            className="mt-0.5 truncate text-xs leading-5 text-wb-fg-3"
          >
            {status === null
              ? "正在读取…"
              : !status.supported
              ? "仅桌面客户端支持安装命令行工具。"
              : status.installed
              ? status.shimPath ?? "已安装"
              : "安装后可在任意终端目录直接唤起 AI Workbench。"}
          </div>
          {status?.supported && status.installed && !status.onPath ? (
            <p className="mt-1 text-xs leading-5 text-wb-warn">
              已创建启动脚本，请确认对应目录已加入终端 PATH（新开终端窗口生效）。
            </p>
          ) : justInstalled && status?.installed ? (
            <p className="mt-1 text-xs leading-5 text-wb-fg-3" role="status">
              已就绪，新打开的终端窗口即可直接使用 <code className="font-mono">aiwb .</code>。
            </p>
          ) : null}
        </div>
        {status?.supported ? (
          status.installed ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-cli-command-uninstall=""
              disabled={busy}
              className="shrink-0"
              onClick={() => void handleUninstall()}
            >
              {busy ? "卸载中" : "卸载"}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-cli-command-install=""
              disabled={busy}
              className="shrink-0"
              onClick={() => void handleInstall()}
            >
              {busy ? "安装中" : "安装"}
            </Button>
          )
        ) : null}
      </div>
      {error && (
        <p className="mt-3 text-sm text-wb-danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
