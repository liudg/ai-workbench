import { useEffect, useState } from "react";

import { backend, type TaskFolder } from "@/lib/ipc";

/** 无项目任务文件夹。展示组件只拿这里的结果。 */
export function useTaskFolder() {
  const [folder, setFolder] = useState<TaskFolder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void backend.taskFolder().then(
      (value) => {
        if (live) setFolder(value);
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const change = async () => {
    setError(null);
    const picked = await backend.pickDirectory("选择无项目任务文件夹");
    if (!picked) return;
    setBusy(true);
    try {
      setFolder(await backend.setTaskFolder(picked));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return { folder, error, busy, change };
}
