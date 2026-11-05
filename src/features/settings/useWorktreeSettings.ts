import { useEffect, useState } from "react";

import { daemon } from "@/lib/daemon";
import { pickFolder } from "@/lib/native/pick-folder";
import { userFacingMessage } from "@/lib/user-facing";

export interface WorktreeSettings {
  root: string;
  defaultRoot: string;
  autoCleanup: boolean;
  keepCount: number;
}

type Patch = Partial<Pick<WorktreeSettings, "root" | "autoCleanup" | "keepCount">>;

/** 工作树的目录、自动清理和保留个数。展示组件只拿这里的结果。 */
export function useWorktreeSettings() {
  const [settings, setSettings] = useState<WorktreeSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void daemon.call<WorktreeSettings>("settings.worktrees").then(
      (value) => {
        if (live) setSettings(value);
      },
      (err: unknown) => {
        if (live) setError(userFacingMessage(err) ?? "读不到工作树设置");
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const save = async (patch: Patch) => {
    setError(null);
    setBusy(true);
    try {
      setSettings(await daemon.call<WorktreeSettings>("settings.setWorktrees", patch));
    } catch (err) {
      setError(userFacingMessage(err) ?? "无法保存工作树设置");
    } finally {
      setBusy(false);
    }
  };

  const changeRoot = async () => {
    const picked = await pickFolder("选择工作树目录");
    if (picked) await save({ root: picked });
  };

  return {
    settings,
    error,
    busy,
    changeRoot,
    resetRoot: () => save({ root: "" }),
    setAutoCleanup: (autoCleanup: boolean) => save({ autoCleanup }),
    setKeepCount: (keepCount: number) => save({ keepCount }),
  };
}
