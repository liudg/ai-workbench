import { useEffect, useState } from "react";

import { daemon } from "@/lib/daemon";
import { pickFolder } from "@/lib/native/pick-folder";
import { userFacingMessage } from "@/lib/user-facing";

interface TaskFolder {
  path: string;
  label: string;
}

/** 无项目任务文件夹。展示组件只拿这里的结果。 */
export function useTaskFolder() {
  const [folder, setFolder] = useState<TaskFolder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void daemon.call<TaskFolder>("settings.taskFolder").then(
      (value) => {
        if (live) setFolder(value);
      },
      (err: unknown) => {
        if (live) setError(userFacingMessage(err) ?? "读不到任务文件夹");
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const change = async () => {
    setError(null);
    const picked = await pickFolder("选择无项目任务文件夹");
    if (!picked) return;
    setBusy(true);
    try {
      setFolder(await daemon.call<TaskFolder>("settings.setTaskFolder", { path: picked }));
    } catch (err) {
      setError(userFacingMessage(err) ?? "无法更改任务文件夹");
    } finally {
      setBusy(false);
    }
  };

  return { folder, error, busy, change };
}
