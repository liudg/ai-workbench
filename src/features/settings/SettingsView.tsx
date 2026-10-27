import { useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AgentInstallation } from "@/types";
import { useAgentSettings } from "./useAgentSettings";
import { useTaskFolder } from "./useTaskFolder";
import { Button } from "@/components/ui/button";
import { agentCardFace, statusLabel, type AgentCardFace } from "./agent-card";
import { McpSettings } from "./mcp/McpSettings";
import { MCP_PAGE } from "./mcp/view";

function StatusLine({ face }: { face: AgentCardFace }) {
  if (face.kind === "unwired") {
    return (
      <p className="mt-1 text-xs text-zinc-500">
        {face.lead}
        {" · "}
        <span className="text-red-400">未接入</span>
      </p>
    );
  }
  return <p className="mt-1 text-xs text-zinc-500">{statusLabel(face)}</p>;
}

function AgentCard({
  item,
  updating,
  updateLocked,
  error,
  onUpdate,
}: {
  item: AgentInstallation;
  updating: boolean;
  updateLocked: boolean;
  error: string | null;
  onUpdate: (kind: AgentInstallation["kind"]) => void;
}) {
  const face = agentCardFace(item);
  return (
    <li
      data-agent={item.kind}
      data-installed={item.installed ? "true" : "false"}
      data-card={face.kind}
      className="flex items-start gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-100">{item.display_name}</div>
        <StatusLine face={face} />
        {face.kind === "ready" && face.detail && (
          <div className="mt-1 text-xs leading-5 text-amber-200/90">{face.detail}</div>
        )}
        {error && (
          <p className="mt-1 text-xs leading-5 text-red-300" role="alert">
            {error}
          </p>
        )}
      </div>
      {(face.kind === "ready" || face.kind === "unwired") && face.canUpdate && (
        <Button
          type="button"
          size="sm"
          disabled={updateLocked}
          aria-label={`更新 ${item.display_name}`}
          onClick={() => onUpdate(item.kind)}
        >
          {updating ? "更新中" : "更新"}
        </Button>
      )}
    </li>
  );
}

function AgentsPanel() {
  const { installations, loading, error, updateErrors, updatingKind, refresh, updateInstallation } =
    useAgentSettings();

  return (
    <section>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">本地 Agent</h2>
          <p className="mt-1 max-w-lg text-sm leading-6 text-zinc-500">
            列出全部已注册的 Agent CLI。新建会话只列出已经接入、可以开会话的。工作台不代为安装；已安装的可以按官方方式更新。
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
        loading ? <p className="mt-8 text-sm text-zinc-500">正在检测本地 Agent…</p> : null
      ) : installations.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">没有可管理的本地 Agent。</p>
      ) : (
        <ul className="mt-6 space-y-2">
          {installations.map((item) => (
            <AgentCard
              key={item.kind}
              item={item}
              updating={updatingKind === item.kind}
              updateLocked={updatingKind !== null}
              error={updateErrors[item.kind] ?? null}
              onUpdate={updateInstallation}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function GeneralPanel() {
  const { folder, error, busy, change } = useTaskFolder();
  return (
    <section data-settings-panel="general">
      <h2 className="text-base font-medium text-zinc-100">无项目任务文件夹</h2>
      <p className="mt-1 max-w-lg text-sm leading-6 text-zinc-500">
        在项目外启动的任务默认存储数据的位置。
      </p>
      <div className="mt-6 flex items-center justify-between gap-4 rounded-xl border border-zinc-800 bg-[#161616] px-4 py-3">
        <span
          data-task-folder-label=""
          title={folder?.path ?? ""}
          className="min-w-0 truncate text-sm text-zinc-100"
        >
          {folder?.label ?? "正在读取…"}
        </span>
        <button
          type="button"
          data-task-folder-change=""
          disabled={busy || !folder}
          className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
          onClick={() => void change()}
        >
          更改
        </button>
      </div>
      {error && (
        <p className="mt-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function SettingsView() {
  const { closeSettings } = useAgentSettings();
  const [section, setSection] = useState<"agents" | "general" | "mcp">("agents");

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

      <div className="flex min-h-0 flex-1">
        <nav aria-label="设置" className="w-44 shrink-0 border-r border-zinc-800/80 px-3 py-4">
          <ul className="space-y-1">
            <li>
              <button
                type="button"
                data-settings-nav="agents"
                className={cn(
                  "w-full rounded-md px-3 py-2 text-left text-sm",
                  section === "agents" ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-100",
                )}
                aria-current={section === "agents" ? "page" : undefined}
                onClick={() => setSection("agents")}
              >
                本地 Agent
              </button>
            </li>
            <li>
              <button
                type="button"
                data-settings-nav="mcp"
                className={cn(
                  "w-full rounded-md px-3 py-2 text-left text-sm",
                  section === "mcp" ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-100",
                )}
                aria-current={section === "mcp" ? "page" : undefined}
                onClick={() => setSection("mcp")}
              >
                {MCP_PAGE.nav}
              </button>
            </li>
            <li>
              <button
                type="button"
                data-settings-nav="general"
                className={cn(
                  "w-full rounded-md px-3 py-2 text-left text-sm",
                  section === "general" ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-100",
                )}
                aria-current={section === "general" ? "page" : undefined}
                onClick={() => setSection("general")}
              >
                常规
              </button>
            </li>
          </ul>
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-2xl">
            {section === "agents" ? <AgentsPanel /> : section === "mcp" ? <McpSettings /> : <GeneralPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}
