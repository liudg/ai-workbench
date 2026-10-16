import { useCallback, useEffect, useState } from "react";

import { invoke } from "@/lib/ipc/call";
import type { AgentKind, McpAddSpec, McpServerRow, McpSurface } from "@/types";
import { MCP_PAGE } from "./view";
import { McpPanel } from "./McpPanel";

export function McpSettings() {
  const [surfaces, setSurfaces] = useState<McpSurface[] | null>(null);
  const [selected, setSelected] = useState<AgentKind | null>(null);
  const [rows, setRows] = useState<McpServerRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [toolsText, setToolsText] = useState<string | null>(null);

  const loadList = useCallback(async (kind: AgentKind, known: McpSurface[]) => {
    const surface = known.find((item) => item.kind === kind);
    setRows([]);
    setToolsText(null);
    setNotice(null);
    if (!surface?.manageable || !surface.verbs.list) {
      setListError(null);
      return;
    }
    setListError(null);
    setBusy(true);
    try {
      setRows(await invoke<McpServerRow[]>("mcp_list", { kind }));
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    invoke<McpSurface[]>("mcp_surfaces")
      .then((loaded) => {
        if (!alive) return;
        setSurfaces(loaded);
        const first = loaded.find((item) => item.manageable) ?? loaded[0];
        if (!first) return;
        setSelected(first.kind);
        void loadList(first.kind, loaded);
      })
      .catch((err) => {
        if (!alive) return;
        setSurfaces([]);
        setListError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [loadList]);

  function select(kind: AgentKind) {
    setSelected(kind);
    if (surfaces) void loadList(kind, surfaces);
  }

  async function run(action: () => Promise<string>, failure: string) {
    setBusy(true);
    setNotice(null);
    try {
      const text = await action();
      setNotice(text);
      if (selected && surfaces) await loadList(selected, surfaces);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setNotice(`${failure}\n${detail}`);
    } finally {
      setBusy(false);
    }
  }

  if (surfaces === null) {
    return <p className="text-sm text-zinc-500">正在读取 MCP…</p>;
  }

  return (
    <McpPanel
      surfaces={surfaces}
      selected={selected}
      rows={rows}
      listError={listError}
      busy={busy}
      notice={notice}
      toolsText={toolsText}
      onSelect={select}
      onAdd={(spec: McpAddSpec) => {
        if (!selected) return;
        void run(() => invoke<string>("mcp_add", { kind: selected, spec }), MCP_PAGE.saveError);
      }}
      onRemove={(name, scope) => {
        if (!selected) return;
        void run(() => invoke<string>("mcp_remove", { kind: selected, name, scope }), MCP_PAGE.uninstallError);
      }}
      onLogin={(name, registration, scopes) => {
        if (!selected) return;
        void run(
          () => invoke<string>("mcp_login", { kind: selected, name, registration, scopes }),
          MCP_PAGE.authenticate,
        );
      }}
      onLogout={(name) => {
        if (!selected) return;
        void run(() => invoke<string>("mcp_logout", { kind: selected, name }), "logout");
      }}
      onSetEnabled={(name, enabled) => {
        if (!selected) return;
        void run(() => invoke<string>("mcp_set_enabled", { kind: selected, name, enabled }), MCP_PAGE.enable);
      }}
      onListTools={(name) => {
        if (!selected) return;
        setBusy(true);
        invoke<string>("mcp_list_tools", { kind: selected, name })
          .then(setToolsText)
          .catch((err) => setToolsText(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false));
      }}
    />
  );
}
