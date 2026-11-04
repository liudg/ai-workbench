import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAgentProfiles } from "@/features/agents";
import type { Project } from "@/features/projects";
import { tasksApi, type ImportCandidate, type ImportResult } from "@/features/tasks";
import { userFacingMessage } from "@/lib/user-facing";
import { agentIdentity, type AgentIdentity } from "@/shared/agent/identity";
import { openTask } from "@/shared/shell/navigation";
import { AGENT_LABELS, type AgentKind } from "@/types";
import {
  countLabel,
  defaultAgent,
  hasMore,
  importKey,
  mergeItems,
  NO_PAGES,
  withoutKeys,
  type AgentPages,
  type PagesByAgent,
} from "./import-pages";

export interface ImportRow {
  key: string;
  item: ImportCandidate;
  identity: AgentIdentity | null;
}

export interface ImportTab {
  agent: AgentKind;
  name: string;
  identity: AgentIdentity | null;
  count: string | null;
  failed: boolean;
}

/** 导入对话框：按 Agent 分标签，各自分页读项目主目录下 CLI 里开过的会话，勾选后导入。只导入一条时直接打开它。 */
export function useImportSessions(project: Project, onClose: () => void) {
  const profiles = useAgentProfiles();
  const [sources, setSources] = useState<AgentKind[] | null>(null);
  const [pages, setPages] = useState<PagesByAgent>({});
  const [picked, setPicked] = useState<AgentKind | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlyMap<string, ImportCandidate>>(new Map());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  // 重新读取时作废还在路上的请求；同一个 Agent 同时只取一页。
  const generation = useRef(0);
  const inFlight = useRef(new Set<AgentKind>());

  const loadPage = useCallback(
    (agent: AgentKind, cursor: string | null) => {
      if (inFlight.current.has(agent)) return;
      inFlight.current.add(agent);
      const gen = generation.current;
      const update = (change: (current: AgentPages) => AgentPages) =>
        setPages((current) => ({ ...current, [agent]: change(current[agent] ?? NO_PAGES) }));
      update((current) => ({ ...current, loading: true, error: null }));
      tasksApi.importList(project.id, agent, cursor).then(
        (page) => {
          if (gen !== generation.current) return;
          inFlight.current.delete(agent);
          update((current) => ({
            items: mergeItems(current.items, page.items),
            cursor: page.nextCursor,
            loaded: true,
            loading: false,
            error: null,
          }));
        },
        (error) => {
          if (gen !== generation.current) return;
          inFlight.current.delete(agent);
          update((current) => ({ ...current, loading: false, error: userFacingMessage(error) ?? "读取失败" }));
        },
      );
    },
    [project.id],
  );

  const load = useCallback(() => {
    generation.current += 1;
    inFlight.current = new Set();
    const gen = generation.current;
    setSources(null);
    setPages({});
    setPicked(null);
    setLoadError(null);
    setSelected(new Map());
    tasksApi.importSources().then(
      (next) => {
        if (gen !== generation.current) return;
        setSources(next);
        for (const agent of next) loadPage(agent, null);
      },
      (error) => {
        if (gen === generation.current) setLoadError(userFacingMessage(error) ?? "读取失败");
      },
    );
  }, [loadPage]);

  useEffect(load, [load]);

  const name = (agent: AgentKind) => profiles[agent]?.display_name ?? AGENT_LABELS[agent];

  const tabs: ImportTab[] = (sources ?? []).map((agent) => ({
    agent,
    name: name(agent),
    identity: agentIdentity(agent, profiles[agent]),
    count: countLabel(pages[agent]),
    failed: Boolean(pages[agent]?.error),
  }));

  const active = picked ?? defaultAgent(sources ?? [], pages);
  const current = (active && pages[active]) || NO_PAGES;

  const rows: ImportRow[] = useMemo(
    () =>
      current.items.map((item) => ({
        key: importKey(item),
        item,
        identity: agentIdentity(item.agent, profiles[item.agent]),
      })),
    [current.items, profiles],
  );

  // 用户动过以后标签就不再跟着读取结果跳。
  const hold = () => setPicked((value) => value ?? active);

  const toggle = (row: ImportRow) => {
    hold();
    setSelected((value) => {
      const next = new Map(value);
      if (next.has(row.key)) next.delete(row.key);
      else next.set(row.key, row.item);
      return next;
    });
  };

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.key));
  const toggleAll = () => {
    hold();
    setSelected((value) => {
      const next = new Map(value);
      for (const row of rows) {
        if (allSelected) next.delete(row.key);
        else next.set(row.key, row.item);
      }
      return next;
    });
  };

  const loadMore = () => {
    if (!active || current.loading || current.error || !hasMore(current)) return;
    loadPage(active, current.cursor);
  };

  const retryPage = () => {
    if (active) loadPage(active, current.cursor);
  };

  const submit = async () => {
    const items = [...selected.values()];
    if (items.length === 0 || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const done = await tasksApi.runImport(project.id, items);
      if (done.failures.length === 0) {
        if (done.taskIds.length === 1) openTask(done.taskIds[0], project.id);
        onClose();
        return;
      }
      setResult(done);
      const failed = new Set(done.failures.map(importKey));
      setPages((value) => withoutKeys(value, new Set(items.map(importKey).filter((key) => !failed.has(key)))));
      setSelected(new Map());
    } catch (error) {
      setLoadError(userFacingMessage(error) ?? "导入失败");
    } finally {
      setBusy(false);
    }
  };

  return {
    loading: sources === null && loadError === null,
    loadError,
    retry: load,
    tabs,
    active,
    pick: setPicked,
    activeName: active ? name(active) : "",
    rows,
    pageLoading: current.loading,
    pageLoaded: current.loaded,
    pageError: current.error,
    retryPage,
    hasMore: current.loaded && current.cursor !== null,
    loadMore,
    selected,
    toggle,
    allSelected,
    toggleAll,
    busy,
    submit,
    imported: result?.taskIds.length ?? 0,
    failures: result?.failures ?? [],
  };
}
