import { useEffect, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { THEME_OPTIONS, useTheme, type ThemePreference } from "@/shared/theme/theme";
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
      <p className="mt-1 text-xs text-[var(--wb-muted)]">
        {face.lead}
        {" · "}
        <span className="text-[var(--wb-danger-strong)]">未接入</span>
      </p>
    );
  }
  return <p className="mt-1 text-xs text-[var(--wb-muted)]">{statusLabel(face)}</p>;
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
      className="flex items-start gap-4 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-card)] px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-[var(--wb-text-strong)]">{item.display_name}</div>
        <StatusLine face={face} />
        {face.kind === "ready" && face.detail && (
          <div className="mt-1 text-xs leading-5 text-[var(--wb-warn-text)]">{face.detail}</div>
        )}
        {error && (
          <p className="mt-1 text-xs leading-5 text-[var(--wb-danger-text)]" role="alert">
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
          <h2 className="text-base font-medium text-[var(--wb-text-strong)]">本地 Agent</h2>
          <p className="mt-1 max-w-lg text-sm leading-6 text-[var(--wb-muted)]">
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
        <p className="mt-4 rounded-xl border border-[var(--wb-danger-border)] bg-[var(--wb-danger-bg)] px-3.5 py-2.5 text-sm text-[var(--wb-danger-text)]">
          {error}
        </p>
      )}

      {installations === null ? (
        <p className="mt-8 text-sm text-[var(--wb-muted)]">正在检测本地 Agent…</p>
      ) : installations.length === 0 ? (
        <p className="mt-8 text-sm text-[var(--wb-muted)]">没有可管理的本地 Agent。</p>
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

function GraphiteMiniScene() {
  return (
    <div className="flex h-full w-full gap-1.5 bg-[#090b10] p-1.5">
      <div className="flex w-8 shrink-0 flex-col justify-between py-0.5 pl-0.5">
        <div className="h-1.5 w-3.5 rounded-full bg-[#e8ecf4]/80" />
        <div className="space-y-1">
          <div className="flex items-center gap-1 rounded-[3px] bg-white/[0.08] px-1 py-[3px]">
            <div className="h-2 w-[2px] rounded-full bg-[#818cf8]" />
            <div className="h-1 flex-1 rounded-full bg-[#f8fafc]/85" />
          </div>
          <div className="px-1">
            <div className="h-1 w-5 rounded-full bg-[#64748b]/60" />
          </div>
        </div>
        <div className="h-2 w-2 rounded-full bg-white/15" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-between rounded-[7px] border border-white/[0.08] bg-[#12151e] p-1.5">
        <div className="flex justify-end">
          <div className="h-2 w-8 rounded-full border border-white/10 bg-[#212636]" />
        </div>
        <div className="space-y-1">
          <div className="h-1 w-10 rounded-full bg-[#cbd5e1]/75" />
          <div className="flex items-center justify-between rounded-[5px] border border-white/[0.12] bg-[#191d29] px-1.5 py-[3px]">
            <div className="h-1 w-6 rounded-full bg-[#64748b]/75" />
            <div className="h-2 w-2 rounded-full bg-[#eef2ff]" />
          </div>
        </div>
      </div>
    </div>
  );
}

function DaylightMiniScene() {
  return (
    <div className="flex h-full w-full gap-1.5 bg-[#f2f3f7] p-1.5">
      <div className="flex w-8 shrink-0 flex-col justify-between py-0.5 pl-0.5">
        <div className="h-1.5 w-3.5 rounded-full bg-[#18181b]/75" />
        <div className="space-y-1">
          <div className="flex items-center gap-1 rounded-[3px] bg-white px-1 py-[3px] shadow-2xs ring-1 ring-[#d4d8e2]/80">
            <div className="h-2 w-[2px] rounded-full bg-[#2563eb]" />
            <div className="h-1 flex-1 rounded-full bg-[#0f1117]/80" />
          </div>
          <div className="px-1">
            <div className="h-1 w-5 rounded-full bg-[#94a3b8]/75" />
          </div>
        </div>
        <div className="h-2 w-2 rounded-full bg-[#cbd5e1]" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-between rounded-[7px] border border-[#e5e7ee] bg-white p-1.5 shadow-2xs">
        <div className="flex justify-end">
          <div className="h-2 w-8 rounded-full border border-[#e2e5ee] bg-[#f1f3f8]" />
        </div>
        <div className="space-y-1">
          <div className="h-1 w-10 rounded-full bg-[#334155]/75" />
          <div className="flex items-center justify-between rounded-[5px] border border-[#d4d8e2] bg-white px-1.5 py-[3px]">
            <div className="h-1 w-6 rounded-full bg-[#94a3b8]" />
            <div className="h-2 w-2 rounded-full bg-[#141720]" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ThemeSwatch({ id, active }: { id: ThemePreference; active: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative h-[84px] w-full overflow-hidden rounded-[11px] border transition-all group-focus-visible:ring-2 group-focus-visible:ring-[var(--wb-accent)]/35",
        active
          ? "border-[var(--wb-accent)] ring-2 ring-[var(--wb-accent)]/20"
          : "border-[var(--wb-border-strong)] opacity-90 group-hover:border-[var(--wb-muted)]/60 group-hover:opacity-100",
      )}
    >
      {id === "graphite" ? (
        <GraphiteMiniScene />
      ) : id === "daylight" ? (
        <DaylightMiniScene />
      ) : (
        <div className="grid h-full w-full grid-cols-2">
          <div className="flex flex-col justify-between bg-[#090b10] p-1.5">
            <div className="flex items-center gap-1">
              <div className="h-2 w-[2px] rounded-full bg-[#818cf8]" />
              <div className="h-1 w-5 rounded-full bg-[#e8ecf4]/85" />
            </div>
            <div className="space-y-1 rounded-[6px] border border-white/10 bg-[#12151e] p-1.5">
              <div className="h-1 w-7 rounded-full bg-[#cbd5e1]/75" />
              <div className="flex items-center justify-between rounded-[4px] border border-white/12 bg-[#191d29] px-1 py-[2px]">
                <div className="h-1 w-4 rounded-full bg-[#64748b]" />
                <div className="h-1.5 w-1.5 rounded-full bg-[#eef2ff]" />
              </div>
            </div>
          </div>
          <div className="flex flex-col justify-between border-l border-[#d4d8e2] bg-[#f2f3f7] p-1.5">
            <div className="flex items-center justify-end gap-1">
              <div className="h-1 w-5 rounded-full bg-[#18181b]/75" />
              <div className="h-2 w-[2px] rounded-full bg-[#2563eb]" />
            </div>
            <div className="space-y-1 rounded-[6px] border border-[#e5e7ee] bg-white p-1.5 shadow-2xs">
              <div className="h-1 w-7 rounded-full bg-[#334155]/75" />
              <div className="flex items-center justify-between rounded-[4px] border border-[#d4d8e2] bg-white px-1 py-[2px]">
                <div className="h-1 w-4 rounded-full bg-[#94a3b8]" />
                <div className="h-1.5 w-1.5 rounded-full bg-[#141720]" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GeneralPanel() {
  const { folder, error, busy, change } = useTaskFolder();
  const { preference, setPreference } = useTheme();

  return (
    <section data-settings-panel="general" className="space-y-10">
      <div>
        <h2 className="text-base font-medium text-[var(--wb-text-strong)]">外观主题</h2>
        <div
          role="radiogroup"
          aria-label="外观主题"
          className="mt-3.5 grid max-w-[468px] grid-cols-3 gap-3.5"
        >
          {THEME_OPTIONS.map((option) => {
            const active = preference === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                data-settings-theme={option.id}
                onClick={() => setPreference(option.id)}
                className="group flex flex-col items-start text-left outline-none"
              >
                <ThemeSwatch id={option.id} active={active} />
                <div className="mt-2 flex items-center gap-1.5 px-0.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                      active
                        ? "border-[var(--wb-accent)] bg-[var(--wb-accent)]"
                        : "border-[var(--wb-border-strong)] bg-transparent group-hover:border-[var(--wb-muted)]",
                    )}
                  >
                    {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                  </span>
                  <span
                    className={cn(
                      "text-[13px] leading-5 transition-colors",
                      active
                        ? "font-medium text-[var(--wb-text-strong)]"
                        : "text-[var(--wb-muted)] group-hover:text-[var(--wb-text-strong)]",
                    )}
                  >
                    {option.label}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-[var(--wb-border)] pt-8">
        <h2 className="text-base font-medium text-[var(--wb-text-strong)]">无项目任务文件夹</h2>
        <p className="mt-1 max-w-lg text-sm leading-6 text-[var(--wb-muted)]">
          在项目外启动的任务默认存储数据的位置。
        </p>
        <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-card)] px-4 py-3">
          <span
            data-task-folder-label=""
            title={folder?.path ?? ""}
            className="min-w-0 truncate text-sm text-[var(--wb-text-strong)]"
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
          <p className="mt-3 text-sm text-[var(--wb-danger-text)]" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

export function SettingsView() {
  const { closeSettings } = useAgentSettings();
  const [section, setSection] = useState<"agents" | "general" | "mcp">("agents");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (
        document.querySelector(
          '[role="dialog"], [data-command-menu], [data-mcp-menu], [data-mcp-popover], [data-fixed-menu]',
        )
      ) {
        return;
      }
      event.preventDefault();
      closeSettings();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSettings]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[var(--wb-canvas)] text-[var(--wb-text)]">
      <header className="flex items-center gap-3 border-b border-[var(--wb-border)] px-6 py-3.5">
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35"
          aria-label="返回工作区"
          onClick={closeSettings}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-sm font-semibold text-[var(--wb-text-strong)]">设置</h1>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="设置" className="w-44 shrink-0 border-r border-[var(--wb-border)] px-3 py-4">
          <ul className="space-y-1">
            <li>
              <button
                type="button"
                data-settings-nav="agents"
                className={cn(
                  "w-full rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35",
                  section === "agents"
                    ? "bg-[var(--wb-chip)] font-medium text-[var(--wb-text-strong)]"
                    : "text-[var(--wb-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]",
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
                  "w-full rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35",
                  section === "mcp"
                    ? "bg-[var(--wb-chip)] font-medium text-[var(--wb-text-strong)]"
                    : "text-[var(--wb-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]",
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
                  "w-full rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35",
                  section === "general"
                    ? "bg-[var(--wb-chip)] font-medium text-[var(--wb-text-strong)]"
                    : "text-[var(--wb-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]",
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
