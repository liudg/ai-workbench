import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@/lib/ipc/call";
import type { AgentKind, McpAddSpec, McpServerRow, McpSurface } from "@/types";
import { emptyBook, finishList, startList, visibleList, type McpListBook } from "./listState";
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
  const [book, setBook] = useState<McpListBook>(emptyBook);
  const generations = useRef<Record<string, number>>({});
  const selectedRef = useRef<AgentKind | null>(selected);
  selectedRef.current = selected;
  const [rowBusy, setRowBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [formBusy, setFormBusy] = useState(false);
  const [feedback, setFeedback] = useState<McpFeedback | null>(null);
  const [highlight, setHighlight] = useState<{ name: string; token: number } | null>(null);
  const [tools, setTools] = useState<Record<string, McpToolEntry[]>>({});

  const loadList = useCallback(async (kind: AgentKind, known: McpSurface[], refresh: boolean) => {
    const surface = known.find((item) => item.kind === kind);
    const generation = (generations.current[kind] ?? 0) + 1;
    generations.current[kind] = generation;
    if (!refresh) {
      setTools({});
      setFeedback(null);
      setHighlight(null);
    }
    setBook((current) => startList(current, kind, generation, refresh));
    if (!surface?.manageable || !surface.verbs.list) {
      setBook((current) => finishList(current, kind, generation, { rows: [] }));
      return;
    }
    try {
      const rows = await invoke<McpServerRow[]>("mcp_list", { kind });
      setBook((current) => finishList(current, kind, generation, { rows }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      setBook((current) => finishList(current, kind, generation, { error }));
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
        selectedRef.current = first.kind;
        setSelected(first.kind);
        void loadList(first.kind, loaded, false);
      })
      .catch((err) => {
        if (!alive) return;
        setSurfaces([]);
        const detail = err instanceof Error ? err.message : String(err);
        setFeedback({ tone: "failure", title: MCP_PAGE.listErrorTitle, detail });
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
    selectedRef.current = kind;
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

  const list = visibleList(book, selected);

  return (
    <McpPanel
      surfaces={surfaces}
      selected={selected}
      rows={list.rows}
      listError={list.error}
      listing={list.listing}
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
        const kind = selected;
        const generation = generations.current[kind] ?? 0;
        setRowBusy((current) => withRowBusy(current, name));
        setFeedback(null);
        invoke<string>("mcp_list_tools", { kind, name })
          .then((text) => {
            if (selectedRef.current !== kind || (generations.current[kind] ?? 0) !== generation) return;
            setTools((current) => ({ ...current, [name]: parseToolList(text) }));
          })
          .catch((err) => {
            if (selectedRef.current !== kind) return;
            const detail = err instanceof Error ? err.message : String(err);
            setFeedback({ tone: "failure", title: failureTitle("tools"), detail });
          })
          .finally(() => {
            if (selectedRef.current !== kind) return;
            setRowBusy((current) => withoutRowBusy(current, name));
          });
      }}
    />
  );
}
