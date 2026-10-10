import { ArrowLeft, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store";
import type { AgentInstallation, UpdateVia } from "@/types";
import { Button } from "./ui/button";

function viaLabel(via: UpdateVia | null): string | null {
  if (via === "npm") return "npm";
  if (via === "cli") return "官方 CLI";
  return null;
}

function statusLine(item: AgentInstallation): string {
  if (!item.installed) return "未安装";
  const version = item.version ?? "已安装";
  if (item.update_available && item.latest_version) {
    const via = viaLabel(item.update_via);
    return via
      ? `${version} · 可更新到 ${item.latest_version} · ${via}`
      : `${version} · 可更新到 ${item.latest_version}`;
  }
  if (item.latest_version && item.version === item.latest_version) {
    return `${version} · 已是最新`;
  }
  return version;
}

export function SettingsView() {
  const installations = useWorkbench((s) => s.installations);
  const loading = useWorkbench((s) => s.installationsLoading);
  const error = useWorkbench((s) => s.installationError);
  const updatingKind = useWorkbench((s) => s.updatingKind);
  const refresh = useWorkbench((s) => s.refreshInstallations);
  const updateInstallation = useWorkbench((s) => s.updateInstallation);
  const closeSettings = useWorkbench((s) => s.closeSettings);
  const rows = installations ?? [];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-800/80 px-6 py-4">
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-800/70 hover:text-zinc-50"
          aria-label="返回工作区"
          onClick={closeSettings}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-sm font-semibold text-zinc-100">设置</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-medium text-zinc-100">本地 Agent</h2>
              <p className="mt-1 max-w-lg text-sm leading-6 text-zinc-500">
                检测这台电脑上已安装的 Agent CLI。有更新时，可以按各自的官方方式升级。
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || updatingKind !== null}
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              重新检测
            </Button>
          </div>

          {error && (
            <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </p>
          )}

          {installations === null ? (
            <p className="mt-8 text-sm text-zinc-500">正在检测本地 Agent…</p>
          ) : rows.length === 0 ? (
            <p className="mt-8 text-sm text-zinc-500">没有可管理的本地 Agent。</p>
          ) : (
            <ul className="mt-6 space-y-2">
              {rows.map((item) => {
                const updating = updatingKind === item.kind;
                return (
                  <li
                    key={item.kind}
                    className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-zinc-100">
                        {item.display_name}
                      </div>
                      <div className="mt-1 text-xs text-zinc-500">{statusLine(item)}</div>
                      {item.detail && (
                        <div className="mt-1 text-xs leading-5 text-amber-200/90">
                          {item.detail}
                        </div>
                      )}
                    </div>
                    {item.update_available && (
                      <Button
                        type="button"
                        size="sm"
                        disabled={updatingKind !== null}
                        aria-label={`更新 ${item.display_name}`}
                        onClick={() => void updateInstallation(item.kind)}
                      >
                        {updating ? "更新中" : "更新"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
