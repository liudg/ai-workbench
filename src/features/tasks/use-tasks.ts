import { useCallback, useState } from "react";

import { daemon, TOPIC_TASKS, useTopic } from "@/lib/daemon";
import type { CreateTaskInput, TaskEntry } from "./types";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useTasks() {
  const tasks = useTopic<TaskEntry[]>(TOPIC_TASKS);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | null> => {
    try {
      setError(null);
      return await work();
    } catch (e) {
      setError(message(e));
      return null;
    }
  }, []);

  const createTask = useCallback(
    (input: CreateTaskInput) => run(() => daemon.call<TaskEntry>("tasks.create", { ...input })),
    [run],
  );
  const renameTask = useCallback(
    (id: string, title: string) => run(() => daemon.call<boolean>("tasks.rename", { id, title })),
    [run],
  );
  const archiveTask = useCallback(
    (id: string, archived: boolean) => run(() => daemon.call<boolean>("tasks.archive", { id, archived })),
    [run],
  );
  const removeTask = useCallback(
    (id: string) => run(() => daemon.call<boolean>("tasks.remove", { id })),
    [run],
  );

  return {
    tasks: tasks ?? [],
    loading: tasks === undefined,
    error,
    dismissError: () => setError(null),
    createTask,
    renameTask,
    archiveTask,
    removeTask,
  };
}
