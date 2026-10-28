import { useCallback, useEffect, useMemo, useState } from "react";

import { useAgentProfiles } from "@/features/agents";
import type { Project } from "@/features/projects";
import { tasksApi, type ImportCandidate, type ImportList, type ImportResult } from "@/features/tasks";
import { userFacingMessage } from "@/lib/user-facing";
import { agentIdentity, type AgentIdentity } from "@/shared/agent/identity";
import { openTask } from "@/shared/shell/navigation";
import { AGENT_LABELS } from "@/types";

export interface ImportRow {
  key: string;
  item: ImportCandidate;
  identity: AgentIdentity | null;
}

export function importKey(item: Pick<ImportCandidate, "agent" | "nativeId">): string {
  return `${item.agent}:${item.nativeId}`;
}

/** 导入对话框：读项目主目录下 CLI 里开过的会话，勾选后导入。只导入一条时直接打开它。 */
export function useImportSessions(project: Project, onClose: () => void) {
  const profiles = useAgentProfiles();
  const [list, setList] = useState<ImportList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const load = useCallback(() => {
    setList(null);
    setLoadError(null);
    tasksApi.importList(project.id).then(
      (next) => {
        setList(next);
        setSelected(new Set());
      },
      (error) => setLoadError(userFacingMessage(error) ?? "读取失败"),
    );
  }, [project.id]);

  useEffect(load, [load]);

  const rows: ImportRow[] = useMemo(
    () =>
      (list?.items ?? []).map((item) => ({
        key: importKey(item),
        item,
        identity: agentIdentity(item.agent, profiles[item.agent]),
      })),
    [list, profiles],
  );

  const sourceErrors = (list?.errors ?? []).map(
    (error) => `${profiles[error.agent]?.display_name ?? AGENT_LABELS[error.agent]}：${error.message}`,
  );

  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.key));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.key)));

  const submit = async () => {
    const items = rows.filter((row) => selected.has(row.key)).map((row) => row.item);
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
      setList((current) =>
        current && { ...current, items: current.items.filter((item) => failed.has(importKey(item))) },
      );
      setSelected(new Set());
    } catch (error) {
      setLoadError(userFacingMessage(error) ?? "导入失败");
    } finally {
      setBusy(false);
    }
  };

  return {
    loading: list === null && loadError === null,
    loadError,
    retry: load,
    rows,
    sourceErrors,
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
