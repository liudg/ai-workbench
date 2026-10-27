import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "./api";
import type { AgentKind, McpAddSpec, McpSurface } from "@/types";
import {
  clearSuccess,
  visibleFeedback,
  writeFeedback,
  type McpFeedbackBook,
} from "./feedbackState";
import { emptyBook, finishList, startList, visibleList, type McpListBook } from "./listState";
import { beginForm, beginRow, busyNames, emptyBusy, endForm, endRow, formBusy, type McpBusyBook } from "./busyState";
import { McpPanel } from "./McpPanel";
import {
  MCP_PAGE,
  failureTitle,
  parseToolList,
  successText,
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
  const [busy, setBusy] = useState<McpBusyBook>(emptyBusy);
  const tickets = useRef(0);
  const viewEpoch = useRef(0);
  const feedbackEpoch = useRef(0);
  const toolTickets = useRef<Record<string, number>>({});
  const [feedbackBook, setFeedbackBook] = useState<McpFeedbackBook>({});
  const [bootFeedback, setBootFeedback] = useState<McpFeedback | null>(null);
  const [highlight, setHighlight] = useState<{ name: string; token: number } | null>(null);
  const [tools, setTools] = useState<Record<string, McpToolEntry[]>>({});

  const loadList = useCallback(async (kind: AgentKind, known: McpSurface[], refresh: boolean) => {
    const surface = known.find((item) => item.kind === kind);
    const generation = (generations.current[kind] ?? 0) + 1;
    generations.current[kind] = generation;
    if (!refresh) {
      setTools({});
      setHighlight(null);
    }
    setBook((current) => startList(current, kind, generation, refresh));
    if (!surface?.manageable || !surface.verbs.list) {
      setBook((current) => finishList(current, kind, generation, { rows: [] }));
      return;
    }
    try {
      const rows = await api.mcpList(kind);
      setBook((current) => finishList(current, kind, generation, { rows }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      setBook((current) => finishList(current, kind, generation, { error }));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api.mcpSurfaces()
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
        setBootFeedback({ tone: "failure", title: MCP_PAGE.listErrorTitle, detail });
      });
    return () => {
      alive = false;
    };
  }, [loadList]);

  useEffect(() => {
    if (!selected || visibleFeedback(feedbackBook, selected)?.tone !== "success") return;
    const kind = selected;
    const timer = window.setTimeout(() => {
      setFeedbackBook((current) => clearSuccess(current, kind));
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [feedbackBook, selected]);

  function nextTicket(): number {
    tickets.current += 1;
    return tickets.current;
  }

  function markFeedback(): number {
    feedbackEpoch.current += 1;
    return feedbackEpoch.current;
  }

  function select(kind: AgentKind) {
    viewEpoch.current += 1;
    selectedRef.current = kind;
    setSelected(kind);
    setBusy(emptyBusy());
    if (surfaces) void loadList(kind, surfaces, false);
  }

  async function run(action: McpAction, rowName: string | null, actionFn: () => Promise<string>): Promise<boolean> {
    const kind = selected;
    if (!kind) return false;
    const ticket = nextTicket();
    const mark = markFeedback();
    if (rowName) setBusy((current) => beginRow(current, rowName, ticket));
    else setBusy((current) => beginForm(current, ticket));
    setFeedbackBook((current) => writeFeedback(current, kind, null));
    try {
      await actionFn();
      if (feedbackEpoch.current === mark && action !== "tools") {
        setFeedbackBook((current) => writeFeedback(current, kind, { tone: "success", text: successText(action) }));
      }
      if (surfaces) await loadList(kind, surfaces, true);
      return true;
    } catch (err) {
      if (feedbackEpoch.current === mark) {
        const detail = err instanceof Error ? err.message : String(err);
        setFeedbackBook((current) =>
          writeFeedback(current, kind, { tone: "failure", title: failureTitle(action), detail }),
        );
      }
      return false;
    } finally {
      setBusy((current) => (rowName ? endRow(current, rowName, ticket) : endForm(current, ticket)));
    }
  }

  if (surfaces === null) {
    return <p className="text-sm text-zinc-500">{MCP_PAGE.loading}</p>;
  }

  const list = visibleList(book, selected);
  const feedback = selected ? visibleFeedback(feedbackBook, selected) : bootFeedback;

  return (
    <McpPanel
      surfaces={surfaces}
      selected={selected}
      rows={list.rows}
      listError={list.error}
      listing={list.listing}
      rowBusy={new Set(busyNames(busy))}
      formBusy={formBusy(busy)}
      feedback={feedback}
      highlight={highlight}
      tools={tools}
      onSelect={select}
      onAdd={async (spec: McpAddSpec) => {
        const kind = selected;
        if (!kind) return false;
        const seen = viewEpoch.current;
        const ok = await run("save", null, () => api.mcpAdd(kind, spec));
        if (ok && selectedRef.current === kind && viewEpoch.current === seen) {
          setHighlight({ name: spec.name, token: Date.now() });
        }
        return ok;
      }}
      onRemove={(name, scope) => {
        if (!selected) return;
        void run("remove", name, () => api.mcpRemove(selected, name, scope));
      }}
      onLogin={(name, registration, scopes) => {
        if (!selected) return;
        void run("login", name, () =>
          api.mcpLogin(selected, name, registration, scopes),
        );
      }}
      onLogout={(name) => {
        if (!selected) return;
        void run("logout", name, () => api.mcpLogout(selected, name));
      }}
      onSetEnabled={(name, enabled) => {
        if (!selected) return;
        void run(enabled ? "enable" : "disable", name, () =>
          api.mcpSetEnabled(selected, name, enabled),
        );
      }}
      onListTools={(name) => {
        if (!selected) return;
        const kind = selected;
        const ticket = nextTicket();
        const mark = markFeedback();
        const seen = viewEpoch.current;
        toolTickets.current[name] = ticket;
        setBusy((current) => beginRow(current, name, ticket));
        setFeedbackBook((current) => writeFeedback(current, kind, null));
        api.mcpListTools(kind, name)
          .then((text) => {
            if (selectedRef.current !== kind || viewEpoch.current !== seen || toolTickets.current[name] !== ticket) return;
            setTools((current) => ({ ...current, [name]: parseToolList(text) }));
          })
          .catch((err) => {
            if (selectedRef.current !== kind || viewEpoch.current !== seen || feedbackEpoch.current !== mark) return;
            const detail = err instanceof Error ? err.message : String(err);
            setFeedbackBook((current) =>
              writeFeedback(current, kind, { tone: "failure", title: failureTitle("tools"), detail }),
            );
          })
          .finally(() => {
            setBusy((current) => endRow(current, name, ticket));
          });
      }}
    />
  );
}
