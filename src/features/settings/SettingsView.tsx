import { useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AgentInstallation, AgentUpgrade } from "@/types";
import { useAgentSettings } from "./useAgentSettings";
import { useTaskFolder } from "./useTaskFolder";
import { useWorktreeSettings } from "./useWorktreeSettings";
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
  upgrade,
  error,
  onUpdate,
}: {
  item: AgentInstallation;
  updating: boolean;
  updateLocked: boolean;
  upgrade: AgentUpgrade | undefined;
  error: string | null;
  onUpdate: (kind: AgentInstallation["kind"]) => void;
}) {
  const face = agentCardFace(item);
  const updateSucceeded = upgrade?.status === "succeeded";
  return (
    <li
      data-agent={item.kind}
      data-installed={item.installed ? "true" : "false"}
      data-card={face.kind}
      className="flex items-start gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-100">{item.display_name}</div>
        {updateSucceeded ? (
          <p className="mt-1 text-xs text-zinc-500">
            上次检测：{item.version ?? "已安装"}
            <span className="ml-2 text-green-400" role="status">更新成功</span>
          </p>
        ) : <StatusLine face={face} />}
        {face.kind === "ready" && face.detail && (
          <div className="mt-1 text-xs leading-5 text-amber-200/90">{face.detail}</div>
        )}
        {error && (
          <p className="mt-1 text-xs leading-5 text-red-300" role="alert">
            {error}
          </p>
        )}
        {upgrade?.status === "failed" && <p className="mt-1 text-xs text-red-300" role="alert">{upgrade.error ?? "更新失败"}</p>}
        {!updateSucceeded && upgrade?.output && (
          <pre aria-label={`${item.display_name} 更新输出`} className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-400">{upgrade.output}</pre>
        )}
      </div>
      {!updateSucceeded && (updating || ((face.kind === "ready" || face.kind === "unwired") && face.canUpdate)) && (
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
  const { installations, loading, error, updateErrors, upgrades, starting, upgradesReady, refresh, updateInstallation } =
    useAgentSettings();

  return (
    <section>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">本地 Agent</h2>
          <p className="mt-1 max-w-lg text-sm leading-6 text-zinc-500">
            查看和更新本地 Agent，未安装的需自行安装。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
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
              updating={Boolean(starting[item.kind]) || upgrades?.some((entry) => entry.kind === item.kind && entry.status === "running") === true}
              updateLocked={!upgradesReady || Boolean(starting[item.kind]) || upgrades?.some((entry) => entry.kind === item.kind && entry.status === "running") === true}
              upgrade={upgrades?.find((entry) => entry.kind === item.kind)}
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
      <WorktreePanel />
    </section>
  );
}

function KeepCountInput({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (count: number) => void }) {
  const [text, setText] = useState(String(value));
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setText(String(value));
  }
  const commit = () => {
    const count = Number.parseInt(text, 10);
    if (Number.isInteger(count) && count >= 1 && count !== value) onCommit(count);
    else setText(String(value));
  };
  return (
    <input
      type="number"
      min={1}
      data-worktree-keep-count=""
      aria-label="保留的工作树个数"
      value={text}
      disabled={disabled}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className="h-8 w-20 rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-zinc-500 disabled:opacity-50"
    />
  );
}

function WorktreePanel() {
  const { settings, error, busy, changeRoot, resetRoot, setAutoCleanup, setKeepCount } = useWorktreeSettings();
  const custom = settings && settings.root !== settings.defaultRoot;
  return (
    <section data-settings-panel="worktrees" className="mt-10">
      <h2 className="text-base font-medium text-zinc-100">工作树</h2>
      <p className="mt-1 max-w-lg text-sm leading-6 text-zinc-500">
        新工作树放在哪里，旧的什么时候清理。
      </p>
      <div className="mt-6 divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-[#161616]">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm text-zinc-100">工作树目录</div>
            <div data-worktree-root="" title={settings?.root ?? ""} className="mt-0.5 truncate text-xs text-zinc-500">
              {settings?.root ?? "正在读取…"}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {custom ? (
              <button
                type="button"
                disabled={busy}
                className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
                onClick={() => void resetRoot()}
              >
                恢复默认
              </button>
            ) : null}
            <button
              type="button"
              data-worktree-root-change=""
              disabled={busy || !settings}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
              onClick={() => void changeRoot()}
            >
              更改
            </button>
          </div>
        </div>
        <label className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm text-zinc-100">自动清理旧工作树</div>
            <div className="mt-0.5 text-xs leading-5 text-zinc-500">
              超出保留个数时清理最久没用的，置顶和运行中的不清理。清理后可以在任务里恢复。
            </div>
          </div>
          <input
            type="checkbox"
            data-worktree-auto-cleanup=""
            checked={settings?.autoCleanup ?? true}
            disabled={busy || !settings}
            onChange={(event) => void setAutoCleanup(event.target.checked)}
            className="h-4 w-4 shrink-0 accent-zinc-100"
          />
        </label>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="text-sm text-zinc-100">保留个数</div>
          {settings ? (
            <KeepCountInput
              value={settings.keepCount}
              disabled={busy || !settings.autoCleanup}
              onCommit={(count) => void setKeepCount(count)}
            />
          ) : null}
        </div>
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
