import { useCallback, useEffect, useState } from "react";

import { invoke } from "@/lib/ipc/call";
import type { AgentKind, McpAddSpec, McpServerRow, McpSurface } from "@/types";
import { McpPanel } from "./McpPanel";
import {
  MCP_PAGE,
  failureTitle,
  parseToolList,
  successText,
  withRowBusy,
  withoutRowBusy,
  type McpAction,
  type McpFeedback,
  type McpToolEntry,
} from "./view";

export function McpSettings() {
  const [surfaces, setSurfaces] = useState<McpSurface[] | null>(null);
  const [selected, setSelected] = useState<AgentKind | null>(null);
  const [rows, setRows] = useState<McpServerRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const [rowBusy, setRowBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [formBusy, setFormBusy] = useState(false);
  const [feedback, setFeedback] = useState<McpFeedback | null>(null);
  const [highlight, setHighlight] = useState<{ name: string; token: number } | null>(null);
  const [tools, setTools] = useState<Record<string, McpToolEntry[]>>({});

  const loadList = useCallback(async (kind: AgentKind, known: McpSurface[], refresh: boolean) => {
    const surface = known.find((item) => item.kind === kind);
    if (!refresh) {
      setRows([]);
      setTools({});
      setFeedback(null);
      setHighlight(null);
    }
    if (!surface?.manageable || !surface.verbs.list) {
      setListError(null);
      setListing(false);
      return;
    }
    setListError(null);
    setListing(true);
    try {
      setRows(await invoke<McpServerRow[]>("mcp_list", { kind }));
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setListing(false);
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
        void loadList(first.kind, loaded, false);
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

  useEffect(() => {
    if (feedback?.tone !== "success") return;
    const timer = window.setTimeout(() => {
      setFeedback((current) => (current?.tone === "success" ? null : current));
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  function select(kind: AgentKind) {
    setSelected(kind);
    setRowBusy(new Set());
    if (surfaces) void loadList(kind, surfaces, false);
  }

  async function run(action: McpAction, rowName: string | null, actionFn: () => Promise<string>): Promise<boolean> {
    if (rowName) setRowBusy((current) => withRowBusy(current, rowName));
    else setFormBusy(true);
    setFeedback(null);
    try {
      await actionFn();
      if (action !== "tools") setFeedback({ tone: "success", text: successText(action) });
      if (selected && surfaces) await loadList(selected, surfaces, true);
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "failure", title: failureTitle(action), detail });
      return false;
    } finally {
      if (rowName) setRowBusy((current) => withoutRowBusy(current, rowName));
      else setFormBusy(false);
    }
  }

  if (surfaces === null) {
    return <p className="text-sm text-zinc-500">{MCP_PAGE.loading}</p>;
  }

  return (
    <McpPanel
      surfaces={surfaces}
      selected={selected}
      rows={rows}
      listError={listError}
      listing={listing}
      rowBusy={rowBusy}
      formBusy={formBusy}
      feedback={feedback}
      highlight={highlight}
      tools={tools}
      onSelect={select}
      onAdd={async (spec: McpAddSpec) => {
        if (!selected) return false;
        const ok = await run("save", null, () => invoke<string>("mcp_add", { kind: selected, spec }));
        if (ok) setHighlight({ name: spec.name, token: Date.now() });
        return ok;
      }}
      onRemove={(name, scope) => {
        if (!selected) return;
        void run("remove", name, () => invoke<string>("mcp_remove", { kind: selected, name, scope }));
      }}
      onLogin={(name, registration, scopes) => {
        if (!selected) return;
        void run("login", name, () =>
          invoke<string>("mcp_login", { kind: selected, name, registration, scopes }),
        );
      }}
      onLogout={(name) => {
        if (!selected) return;
        void run("logout", name, () => invoke<string>("mcp_logout", { kind: selected, name }));
      }}
      onSetEnabled={(name, enabled) => {
        if (!selected) return;
        void run(enabled ? "enable" : "disable", name, () =>
          invoke<string>("mcp_set_enabled", { kind: selected, name, enabled }),
        );
      }}
      onListTools={(name) => {
        if (!selected) return;
        setRowBusy((current) => withRowBusy(current, name));
        setFeedback(null);
        invoke<string>("mcp_list_tools", { kind: selected, name })
          .then((text) => {
            setTools((current) => ({ ...current, [name]: parseToolList(text) }));
          })
          .catch((err) => {
            const detail = err instanceof Error ? err.message : String(err);
            setFeedback({ tone: "failure", title: failureTitle("tools"), detail });
          })
          .finally(() => setRowBusy((current) => withoutRowBusy(current, name)));
      }}
    />
  );
}
