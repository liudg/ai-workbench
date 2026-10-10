import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { backend } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store";
import type {
  EnvironmentRecord,
  HookRecord,
  McpServerRecord,
  McpTransport,
  PluginCatalog,
  PluginRecord,
  WorktreeSettings,
} from "@/types";

import { ConfirmDialog } from "./confirm";

function Notice({ error, note }: { error: string | null; note?: string | null }) {
  return (
    <>
      {error && (
        <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}
      {note && (
        <p className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-300">
          {note}
        </p>
      )}
    </>
  );
}

function runtimeLabel(status: string): string {
  switch (status) {
    case "notStarted":
      return "未启动";
    case "starting":
      return "正在启动";
    case "connected":
      return "已连接";
    case "authenticationRequired":
      return "需要登录";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "disabled":
      return "已禁用";
    default:
      return "未连接";
  }
}

function authLabel(status: string): string {
  switch (status) {
    case "unsupported":
      return "不需要登录";
    case "notLoggedIn":
      return "未登录";
    case "bearerToken":
      return "Bearer";
    case "oAuth":
      return "OAuth";
    default:
      return "";
  }
}

export function McpPanel() {
  const [servers, setServers] = useState<McpServerRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [commandLine, setCommandLine] = useState("");
  const [url, setUrl] = useState("");
  const [removeName, setRemoveName] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    try {
      setServers(await backend.listMcpServers());
      setError(null);
    } catch (err) {
      setError(String(err));
      setServers((current) => current ?? []);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save() {
    setBusy(true);
    try {
      await backend.addMcpServer({ name, transport, commandLine, url });
      setAdding(false);
      setName("");
      setCommandLine("");
      setUrl("");
      setNote("已保存。选择「重启」后，当前会话才会用上这台服务器。");
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">MCP 服务器</h2>
          <p className="mt-1 max-w-lg text-sm leading-6 text-zinc-500">
            桌面应用、Codex CLI 和 IDE 扩展共用这份配置。列表标出已启用的服务器，以及哪些需要 OAuth。
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
            刷新
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void backend
                .reloadMcpServers()
                .then((report) => {
                  setNote(
                    report.warnings.length
                      ? `已重启。${report.warnings.join(" ")}`
                      : "已重启。",
                  );
                  return refresh();
                })
                .catch((err) => setError(String(err)))
                .finally(() => setBusy(false));
            }}
          >
            重启
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => setAdding(true)}>
            添加服务器
          </Button>
        </div>
      </div>
      <Notice error={error} note={note} />
      {adding && (
        <form
          className="mt-4 space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="block text-xs text-zinc-400">
            名称
            <Input className="mt-1" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="flex gap-2">
            {(["stdio", "http"] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={cn(
                  "rounded-md border px-3 py-1.5 text-xs",
                  transport === item
                    ? "border-indigo-500 bg-indigo-500/15 text-zinc-100"
                    : "border-zinc-700 text-zinc-400",
                )}
                onClick={() => setTransport(item)}
              >
                {item === "stdio" ? "STDIO" : "Streamable HTTP"}
              </button>
            ))}
          </div>
          {transport === "stdio" ? (
            <label className="block text-xs text-zinc-400">
              命令
              <Input
                className="mt-1"
                placeholder='npx -y @upstash/context7-mcp'
                value={commandLine}
                onChange={(event) => setCommandLine(event.target.value)}
              />
            </label>
          ) : (
            <label className="block text-xs text-zinc-400">
              URL
              <Input
                className="mt-1"
                placeholder="https://mcp.example.com/mcp"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setAdding(false)}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              保存
            </Button>
          </div>
        </form>
      )}
      {servers === null ? (
        <p className="mt-8 text-sm text-zinc-500">正在读取 MCP 服务器…</p>
      ) : servers.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">还没有 MCP 服务器。选择「添加服务器」。</p>
      ) : (
        <ul className="mt-6 space-y-2">
          {servers.map((server) => {
            const needsAuth =
              server.transport === "http" &&
              (server.auth_status === "notLoggedIn" ||
                server.runtime_status === "authenticationRequired");
            return (
              <li
                key={server.name}
                className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-zinc-100">{server.name}</div>
                    <div className="mt-1 text-xs text-zinc-500">
                      {server.transport === "http" ? "Streamable HTTP" : "STDIO"}
                      {" · "}
                      {runtimeLabel(server.runtime_status)}
                      {authLabel(server.auth_status) ? ` · ${authLabel(server.auth_status)}` : ""}
                      {` · ${server.tool_names.length} 个工具`}
                      {server.plugin_id ? " · 来自插件" : ""}
                    </div>
                    <div className="mt-1 truncate text-xs text-zinc-600">
                      {server.transport === "http"
                        ? server.url
                        : [server.command, ...server.args].filter(Boolean).join(" ")}
                    </div>
                    {server.tools_error && (
                      <div className="mt-1 text-xs text-amber-200/90">{server.tools_error}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    {!server.plugin_id && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          void backend
                            .setMcpServerEnabled(server.name, !server.enabled)
                            .then(() => refresh())
                            .catch((err) => setError(String(err)))
                            .finally(() => setBusy(false));
                        }}
                      >
                        {server.enabled ? "已启用" : "已禁用"}
                      </Button>
                    )}
                    {needsAuth && (
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          void backend
                            .loginMcpServer(server.name)
                            .then((login) =>
                              setNote(`已打开身份验证。完成后选择「重启」。${login.authorization_url}`),
                            )
                            .catch((err) => setError(String(err)))
                            .finally(() => setBusy(false));
                        }}
                      >
                        身份验证
                      </Button>
                    )}
                    {!server.plugin_id && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => setRemoveName(server.name)}
                      >
                        移除
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={removeName !== null}
        title="移除 MCP 服务器"
        description={
          removeName
            ? `这会从 Codex 配置里移除「${removeName}」。已打开的会话要等你选择「重启」后才停止使用它。`
            : ""
        }
        confirmLabel="移除"
        destructive
        busy={busy}
        onCancel={() => setRemoveName(null)}
        onConfirm={() => {
          if (!removeName) return;
          const target = removeName;
          setBusy(true);
          void backend
            .removeMcpServer(target)
            .then(() => {
              setRemoveName(null);
              setNote("已移除。选择「重启」后对当前会话生效。");
              return refresh();
            })
            .catch((err) => setError(String(err)))
            .finally(() => setBusy(false));
        }}
      />
    </section>
  );
}

export function PluginPanel() {
  const projectPath = useWorkbench((s) => s.projects.find((p) => p.id === s.selectedProjectId)?.path ?? null);
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState("");
  const [refName, setRefName] = useState("");
  const [pending, setPending] = useState<PluginRecord | null>(null);
  const [removeMarket, setRemoveMarket] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    try {
      setCatalog(await backend.listPlugins(projectPath));
      setError(null);
    } catch (err) {
      setError(String(err));
      setCatalog((current) => current ?? { marketplaces: [], errors: [] });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [projectPath]);

  async function install(plugin: PluginRecord) {
    setBusy(true);
    try {
      await backend.installPlugin({
        pluginName: plugin.name,
        marketplacePath: plugin.marketplace_path,
        marketplaceName: plugin.marketplace_name,
      });
      setPending(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">插件</h2>
          <p className="mt-1 max-w-lg text-sm leading-6 text-zinc-500">
            按 marketplace 浏览。已安装的插件可以给新对话加上技能、连接器和 MCP。OpenAI、工作区和你自己的目录会分开展示。
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          刷新
        </Button>
      </div>
      <Notice error={error} />
      {catalog?.errors.map((item) => (
        <p key={item} className="mt-3 text-xs leading-5 text-amber-200/90">
          {item}
        </p>
      ))}
      {catalog === null ? (
        <p className="mt-8 text-sm text-zinc-500">正在读取插件…</p>
      ) : catalog.marketplaces.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">没有可显示的 marketplace。</p>
      ) : (
        catalog.marketplaces.map((market) => (
          <div key={market.name} className="mt-6">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-zinc-200">{market.display_name}</h3>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void backend
                      .upgradeMarketplace(market.name)
                      .then(() => refresh())
                      .catch((err) => setError(String(err)))
                      .finally(() => setBusy(false));
                  }}
                >
                  升级
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setRemoveMarket(market.name)}
                >
                  移除
                </Button>
              </div>
            </div>
            <ul className="mt-2 space-y-2">
              {market.plugins.map((plugin) => (
                <li
                  key={plugin.id}
                  className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-zinc-100">{plugin.display_name}</div>
                    <div className="mt-1 text-xs text-zinc-500">
                      {plugin.developer || plugin.source}
                      {plugin.installed ? " · 已安装" : " · 未安装"}
                      {plugin.availability === "DISABLED_BY_ADMIN" ? " · 管理员已禁用" : ""}
                    </div>
                    {plugin.description && (
                      <div className="mt-1 text-xs leading-5 text-zinc-400">{plugin.description}</div>
                    )}
                  </div>
                  {plugin.installed ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setPending(plugin)}
                    >
                      卸载
                    </Button>
                  ) : plugin.availability === "DISABLED_BY_ADMIN" ? null : (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (plugin.needs_install_confirm) setPending(plugin);
                        else void install(plugin);
                      }}
                    >
                      安装
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      <form
        className="mt-6 space-y-3 rounded-xl border border-zinc-800 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void backend
            .addMarketplace(source, refName)
            .then(() => {
              setSource("");
              setRefName("");
              return refresh();
            })
            .catch((err) => setError(String(err)))
            .finally(() => setBusy(false));
        }}
      >
        <div className="text-sm font-medium text-zinc-200">添加 marketplace</div>
        <Input
          placeholder="本地目录或 Git 地址"
          value={source}
          onChange={(event) => setSource(event.target.value)}
        />
        <Input
          placeholder="可选：Git ref"
          value={refName}
          onChange={(event) => setRefName(event.target.value)}
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={busy || !source.trim()}>
            添加
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={pending !== null}
        title={pending?.installed ? "卸载插件" : "安装插件"}
        description={
          pending?.installed
            ? `卸载「${pending.display_name}」后，它带的技能和 MCP 不会再出现在新对话里。`
            : `安装「${pending?.display_name ?? ""}」前请确认它的钩子和 MCP。未信任的钩子不会自动运行。`
        }
        confirmLabel={pending?.installed ? "卸载" : "安装"}
        destructive={pending?.installed}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          if (pending.installed) {
            setBusy(true);
            void backend
              .uninstallPlugin(pending.id)
              .then(() => {
                setPending(null);
                return refresh();
              })
              .catch((err) => setError(String(err)))
              .finally(() => setBusy(false));
          } else {
            void install(pending);
          }
        }}
      />
      <ConfirmDialog
        open={removeMarket !== null}
        title="移除 marketplace"
        description={`移除「${removeMarket ?? ""}」后，这个来源里未安装的插件不再列出。`}
        confirmLabel="移除"
        destructive
        busy={busy}
        onCancel={() => setRemoveMarket(null)}
        onConfirm={() => {
          if (!removeMarket) return;
          const name = removeMarket;
          setBusy(true);
          void backend
            .removeMarketplace(name)
            .then(() => {
              setRemoveMarket(null);
              return refresh();
            })
            .catch((err) => setError(String(err)))
            .finally(() => setBusy(false));
        }}
      />
    </section>
  );
}

function trustLabel(status: string): string {
  switch (status) {
    case "managed":
      return "托管";
    case "trusted":
      return "已信任";
    case "untrusted":
      return "未信任";
    case "modified":
      return "已修改";
    default:
      return status || "未知";
  }
}

export function HooksPanel() {
  const projectPath = useWorkbench((s) => s.projects.find((p) => p.id === s.selectedProjectId)?.path ?? null);
  const [hooks, setHooks] = useState<HookRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    void backend
      .listHooks(projectPath)
      .then((rows) => {
        if (!cancel) setHooks(rows);
      })
      .catch((err) => {
        if (!cancel) {
          setError(String(err));
          setHooks([]);
        }
      });
    return () => {
      cancel = true;
    };
  }, [projectPath]);

  return (
    <section>
      <h2 className="text-base font-medium text-zinc-100">钩子</h2>
      <p className="mt-1 max-w-lg text-sm leading-6 text-zinc-500">
        按当前项目目录列出生命周期钩子。未信任的钩子在审查前不会运行。对话里也可以输入 /hooks。
      </p>
      {!projectPath && (
        <p className="mt-4 text-sm text-zinc-500">先在侧栏选择一个项目，钩子会按那个目录发现。</p>
      )}
      <Notice error={error} />
      {hooks === null ? (
        <p className="mt-8 text-sm text-zinc-500">正在读取钩子…</p>
      ) : hooks.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">没有发现钩子。</p>
      ) : (
        <ul className="mt-6 space-y-2">
          {hooks.map((hook) => (
            <li
              key={`${hook.cwd}:${hook.event_name}:${hook.handler}`}
              className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3"
            >
              <div className="text-sm font-medium text-zinc-100">{hook.event_name}</div>
              <div className="mt-1 text-xs text-zinc-400">{hook.handler}</div>
              <div className="mt-1 text-xs text-zinc-500">
                {hook.source} · {trustLabel(hook.trust_status)} · {hook.enabled ? "启用" : "未启用"}
              </div>
              {hook.trust_status === "untrusted" && (
                <div className="mt-1 text-xs text-amber-200/90">未信任的钩子在审查前不会运行。</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function WorktreePanel() {
  const projectPath = useWorkbench((s) => s.projects.find((p) => p.id === s.selectedProjectId)?.path ?? null);
  const [settings, setSettings] = useState<WorktreeSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recyclePath, setRecyclePath] = useState<string | null>(null);

  async function refresh() {
    const next = await backend.worktreeSettings(projectPath);
    setSettings(next);
  }

  useEffect(() => {
    void refresh().catch((err) => setError(String(err)));
  }, [projectPath]);

  if (!settings) {
    return <p className="text-sm text-zinc-500">正在读取工作树…</p>;
  }

  return (
    <section>
      <h2 className="text-base font-medium text-zinc-100">工作树</h2>
      <p className="mt-1 max-w-lg text-sm leading-6 text-zinc-500">
        工作树让同一个仓库里的对话互不干扰。默认放在 Codex 主目录的 worktrees 下，保留最近 15 个。对话里用 /worktree new 新建。
      </p>
      <Notice error={error} note={note} />
      <form
        className="mt-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void backend
            .saveWorktreeSettings(settings.root, Number(settings.keep) || 15, settings.auto_prune)
            .then((saved) => setSettings({ ...saved, worktrees: settings.worktrees }))
            .catch((err) => setError(String(err)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="block text-xs text-zinc-400">
          工作树根目录
          <Input
            className="mt-1"
            value={settings.root}
            onChange={(event) => setSettings({ ...settings, root: event.target.value })}
          />
        </label>
        <label className="block text-xs text-zinc-400">
          保留最近
          <Input
            className="mt-1"
            type="number"
            min={1}
            max={100}
            value={settings.keep}
            onChange={(event) => setSettings({ ...settings, keep: Number(event.target.value) })}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={settings.auto_prune}
            onChange={(event) => setSettings({ ...settings, auto_prune: event.target.checked })}
          />
          超出上限时允许清理。清理只把目录移到回收站。
        </label>
        <div className="flex justify-end gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            保存
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || !projectPath}
            onClick={() => {
              if (!projectPath) return;
              setBusy(true);
              void backend
                .createWorktree(projectPath)
                .then((created) => {
                  setNote(`已新建工作树（detached HEAD）：${created.path}`);
                  return refresh();
                })
                .catch((err) => setError(String(err)))
                .finally(() => setBusy(false));
            }}
          >
            新建工作树
          </Button>
        </div>
      </form>
      <ul className="mt-6 space-y-2">
        {settings.worktrees.map((tree) => (
          <li
            key={tree.path}
            className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-zinc-100">{tree.path}</div>
              <div className="mt-1 text-xs text-zinc-500">
                {tree.detached ? "detached HEAD" : tree.branch || "Local"}
              </div>
            </div>
            {tree.path.startsWith(settings.root) && (
              <Button type="button" variant="outline" size="sm" onClick={() => setRecyclePath(tree.path)}>
                移到回收站
              </Button>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={recyclePath !== null}
        title="把工作树移到回收站"
        description="目录会进回收站，不会强制删除。Git 只去掉这条工作树记录。"
        confirmLabel="移到回收站"
        destructive
        busy={busy}
        onCancel={() => setRecyclePath(null)}
        onConfirm={() => {
          if (!recyclePath || !projectPath) return;
          setBusy(true);
          void backend
            .recycleWorktree(projectPath, recyclePath)
            .then(() => {
              setRecyclePath(null);
              return refresh();
            })
            .catch((err) => setError(String(err)))
            .finally(() => setBusy(false));
        }}
      />
    </section>
  );
}

function envLabel(status: string): string {
  switch (status) {
    case "ready":
      return "就绪";
    case "pending":
      return "等待连接";
    case "disconnected":
      return "已断开";
    default:
      return "未知";
  }
}

export function EnvironmentPanel() {
  const [rows, setRows] = useState<EnvironmentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [environmentId, setEnvironmentId] = useState("");
  const [execServerUrl, setExecServerUrl] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => {
    void backend.listEnvironments().then(setRows).catch((err) => setError(String(err)));
  }, []);

  return (
    <section>
      <h2 className="text-base font-medium text-zinc-100">环境</h2>
      <p className="mt-1 max-w-lg text-sm leading-6 text-zinc-500">
        把远程 exec server 加进当前 Codex 进程。状态只观察，不会主动重连。本地工作树的安装脚本仍写在项目的 .codex 目录里。
      </p>
      <Notice error={error} />
      <form
        className="mt-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void backend
            .addEnvironment({
              environmentId,
              execServerUrl,
              authBearerToken: token,
            })
            .then(async (created) => {
              setEnvironmentId("");
              setExecServerUrl("");
              setToken("");
              const listed = await backend.listEnvironments();
              setRows(listed.length ? listed : [created]);
            })
            .catch((err) => setError(String(err)))
            .finally(() => setBusy(false));
        }}
      >
        <Input
          placeholder="环境 ID"
          value={environmentId}
          onChange={(event) => setEnvironmentId(event.target.value)}
        />
        <Input
          placeholder="Exec server URL"
          value={execServerUrl}
          onChange={(event) => setExecServerUrl(event.target.value)}
        />
        <Input
          placeholder="可选：Bearer token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={busy}>
            添加环境
          </Button>
        </div>
      </form>
      <ul className="mt-6 space-y-2">
        {rows.map((row) => (
          <li key={row.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <div className="text-sm font-medium text-zinc-100">{row.id}</div>
            <div className="mt-1 text-xs text-zinc-500">
              {envLabel(row.status)}
              {row.shell ? ` · ${row.shell}` : ""}
              {row.cwd ? ` · ${row.cwd}` : ""}
            </div>
            {row.error && <div className="mt-1 text-xs text-amber-200/90">{row.error}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
