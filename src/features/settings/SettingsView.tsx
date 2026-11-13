import { useState } from "react";
import { ArrowLeft, Monitor, Moon, RefreshCw, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SidebarToggle } from "@/shared/shell/SidebarToggle";
import type { AgentInstallation, AgentUpgrade } from "@/types";

import { agentCardFace, statusLabel, type AgentCardFace } from "./agent-card";
import { McpSettings } from "./mcp/McpSettings";
import { MCP_PAGE } from "./mcp/view";
import { useAgentSettings } from "./useAgentSettings";
import { useAppearanceSettings, type ThemePreference } from "./useAppearanceSettings";
import { useTaskFolder } from "./useTaskFolder";
import { useWorktreeSettings } from "./useWorktreeSettings";

function StatusLine({ face }: { face: AgentCardFace }) {
  if (face.kind === "unwired") {
    return (
      <p className="mt-1 text-xs text-wb-fg-3">
        {face.lead}
        {" · "}
        <span className="text-wb-danger">未接入</span>
      </p>
    );
  }
  return <p className="mt-1 text-xs text-wb-fg-3">{statusLabel(face)}</p>;
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
      className="flex items-start gap-4 rounded-xl border border-wb-border bg-wb-elev px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-wb-fg">{item.display_name}</div>
        {updateSucceeded ? (
          <p className="mt-1 text-xs text-wb-fg-3">
            上次检测：{item.version ?? "已安装"}
            <span className="ml-2 text-wb-ok" role="status">更新成功</span>
          </p>
        ) : (
          <StatusLine face={face} />
        )}
        {face.kind === "ready" && face.detail && (
          <div className="mt-1 text-xs leading-5 text-wb-warn">{face.detail}</div>
        )}
        {error && (
          <p className="mt-1 text-xs leading-5 text-wb-danger" role="alert">
            {error}
          </p>
        )}
        {upgrade?.status === "failed" && (
          <p className="mt-1 text-xs text-wb-danger" role="alert">
            {upgrade.error ?? "更新失败"}
          </p>
        )}
        {!updateSucceeded && upgrade?.output && (
          <pre
            aria-label={`${item.display_name} 更新输出`}
            className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-wb-code p-2.5 text-xs text-wb-fg-2"
          >
            {upgrade.output}
          </pre>
        )}
      </div>
      {!updateSucceeded && (updating || ((face.kind === "ready" || face.kind === "unwired") && face.canUpdate)) && (
        <Button
          type="button"
          variant="outline"
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
          <h2 className="text-base font-semibold text-wb-fg">本地 Agent</h2>
          <p className="mt-1 max-w-lg text-sm leading-6 text-wb-fg-2">
            检测或更新本机已安装的 Agent CLI。
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
        <p className="mt-4 rounded-xl border border-wb-danger/30 bg-wb-danger-soft px-3.5 py-2.5 text-sm text-wb-danger">
          {error}
        </p>
      )}

      {installations === null ? (
        loading ? <p className="mt-8 text-sm text-wb-fg-3">正在检测本地 Agent…</p> : null
      ) : installations.length === 0 ? (
        <p className="mt-8 text-sm text-wb-fg-3">没有可管理的本地 Agent。</p>
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

function ThemePreviewIcon({ id }: { id: ThemePreference }) {
  if (id === "obsidian") return <Moon className="h-3.5 w-3.5" />;
  if (id === "daylight") return <Sun className="h-3.5 w-3.5" />;
  return <Monitor className="h-3.5 w-3.5" />;
}

function ThemeSwatch({ id }: { id: ThemePreference }) {
  if (id === "obsidian") {
    return (
      <div className="flex h-12 overflow-hidden rounded-lg border border-[#2a2c33] bg-[#0b0c0e] p-1">
        <div className="w-4 shrink-0 space-y-1 pr-1 pt-0.5">
          <div className="h-1 w-2.5 rounded-full bg-[#3a3d46]" />
          <div className="h-1 w-3 rounded-full bg-[#5b7cf7]" />
        </div>
        <div className="flex-1 rounded-md border border-[#23252c] bg-[#121316] p-1.5">
          <div className="ml-auto h-2 w-8 rounded bg-[#1d212b]" />
          <div className="mt-1 h-1.5 w-10 rounded-full bg-[#2c2f37]" />
        </div>
      </div>
    );
  }
  if (id === "daylight") {
    return (
      <div className="flex h-12 overflow-hidden rounded-lg border border-[#d6d9e0] bg-[#f1f2f5] p-1">
        <div className="w-4 shrink-0 space-y-1 pr-1 pt-0.5">
          <div className="h-1 w-2.5 rounded-full bg-[#c5c9d2]" />
          <div className="h-1 w-3 rounded-full bg-[#3b5bdb]" />
        </div>
        <div className="flex-1 rounded-md border border-[#e3e5ea] bg-[#ffffff] p-1.5">
          <div className="ml-auto h-2 w-8 rounded bg-[#eff2f7]" />
          <div className="mt-1 h-1.5 w-10 rounded-full bg-[#dfe2e8]" />
        </div>
      </div>
    );
  }
  return (
    <div className="grid h-12 grid-cols-2 overflow-hidden rounded-lg border border-wb-border">
      <div className="bg-[#0b0c0e] p-1.5">
        <div className="h-full rounded border border-[#23252c] bg-[#121316]" />
      </div>
      <div className="bg-[#f1f2f5] p-1.5">
        <div className="h-full rounded border border-[#e3e5ea] bg-[#ffffff]" />
      </div>
    </div>
  );
}

function AppearanceSection() {
  const { options, preference, setTheme } = useAppearanceSettings();
  return (
    <div className="mb-10" data-settings-panel="appearance">
      <h2 className="text-base font-semibold text-wb-fg">外观</h2>
      <p className="mt-1 max-w-lg text-sm leading-6 text-wb-fg-2">
        选择工作台配色方案。
      </p>
      <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3" role="radiogroup" aria-label="外观主题">
        {options.map((option) => {
          const active = preference === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-theme-option={option.id}
              onClick={() => setTheme(option.id)}
              className={cn(
                "flex flex-col gap-2.5 rounded-xl border p-3 text-left transition-colors",
                active
                  ? "border-wb-accent bg-wb-accent-soft"
                  : "border-wb-border bg-wb-elev hover:border-wb-border-strong hover:bg-wb-hover",
              )}
            >
              <ThemeSwatch id={option.id} />
              <div>
                <div className="flex items-center gap-1.5 text-sm font-medium text-wb-fg">
                  <ThemePreviewIcon id={option.id} />
                  <span>{option.label}</span>
                </div>
                <p className="mt-0.5 text-xs text-wb-fg-3">{option.hint}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GeneralPanel() {
  const { folder, error, busy, change } = useTaskFolder();
  return (
    <section data-settings-panel="general">
      <AppearanceSection />
      <h2 className="text-base font-semibold text-wb-fg">聊天默认目录</h2>
      <p className="mt-1 max-w-lg text-sm leading-6 text-wb-fg-2">
        未绑定项目的聊天默认使用的工作目录。
      </p>
      <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-wb-border bg-wb-elev px-4 py-3">
        <span
          data-task-folder-label=""
          title={folder?.path ?? ""}
          className="min-w-0 truncate text-sm text-wb-fg"
        >
          {folder?.label ?? "正在读取…"}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-task-folder-change=""
          disabled={busy || !folder}
          className="shrink-0"
          onClick={() => void change()}
        >
          更改
        </Button>
      </div>
      {error && (
        <p className="mt-3 text-sm text-wb-danger" role="alert">
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
      className="h-8 w-20 rounded-lg border border-wb-border-strong bg-wb-input px-2.5 text-sm text-wb-fg outline-none transition-colors focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft disabled:opacity-50"
    />
  );
}

function WorktreePanel() {
  const { settings, error, busy, changeRoot, resetRoot, setAutoCleanup, setKeepCount } = useWorktreeSettings();
  const custom = settings && settings.root !== settings.defaultRoot;
  return (
    <section data-settings-panel="worktrees" className="mt-10">
      <h2 className="text-base font-semibold text-wb-fg">工作树</h2>
      <p className="mt-1 max-w-lg text-sm leading-6 text-wb-fg-2">
        新工作树存放位置与旧工作树保留策略。
      </p>
      <div className="mt-4 divide-y divide-wb-border rounded-xl border border-wb-border bg-wb-elev">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm text-wb-fg">存放目录</div>
            <div data-worktree-root="" title={settings?.root ?? ""} className="mt-0.5 truncate text-xs text-wb-fg-3">
              {settings?.root ?? "正在读取…"}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {custom ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void resetRoot()}
              >
                恢复默认
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-worktree-root-change=""
              disabled={busy || !settings}
              onClick={() => void changeRoot()}
            >
              更改
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm text-wb-fg">自动清理旧工作树</div>
            <div className="mt-0.5 text-xs leading-5 text-wb-fg-3">
              超出保留数量时清理最久未用的工作树；置顶或运行中的对话不清理。
            </div>
          </div>
          <Switch
            data-worktree-auto-cleanup=""
            aria-label="自动清理旧工作树"
            checked={settings?.autoCleanup ?? true}
            disabled={busy || !settings}
            onCheckedChange={(checked) => void setAutoCleanup(checked)}
          />
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="text-sm text-wb-fg">保留数量</div>
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
        <p className="mt-3 text-sm text-wb-danger" role="alert">
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
    <div className="flex h-full min-w-0 flex-1 flex-col bg-wb-surface">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-wb-border px-4">
        <SidebarToggle />
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
          aria-label="返回工作区"
          onClick={closeSettings}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-sm font-semibold text-wb-fg">设置</h1>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="设置" className="w-44 shrink-0 border-r border-wb-border px-2.5 py-4">
          <ul className="space-y-0.5">
            <li>
              <button
                type="button"
                data-settings-nav="agents"
                className={cn(
                  "w-full rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors",
                  section === "agents" ? "bg-wb-active font-medium text-wb-fg" : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
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
                  "w-full rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors",
                  section === "mcp" ? "bg-wb-active font-medium text-wb-fg" : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
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
                  "w-full rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors",
                  section === "general" ? "bg-wb-active font-medium text-wb-fg" : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
                )}
                aria-current={section === "general" ? "page" : undefined}
                onClick={() => setSection("general")}
              >
                常规与外观
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
