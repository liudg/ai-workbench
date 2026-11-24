import { useCallback, useEffect, useState } from "react";

import { OFFLINE_MESSAGE } from "@/lib/daemon";
import { openPath, revealFolder } from "@/lib/native/open-path";
import { userFacingMessage } from "@/lib/user-facing";
import {
  fetchKeybindings,
  hasKeybindingsSnapshot,
  saveKeybindings,
  useKeybindingsTopicSync,
  type KeybindingRule,
} from "@/shared/keybindings";
import { baseName, directoryOf } from "@/shared/path";

import { KeybindingsPanel } from "./KeybindingsPanel";
import { KEYBINDINGS_PAGE } from "./view";

export { KEYBINDINGS_PAGE };

export function KeybindingsSettings() {
  const snapshot = useKeybindingsTopicSync();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (hasKeybindingsSnapshot()) return;
    let alive = true;
    fetchKeybindings().catch((err: unknown) => {
      if (!alive) return;
      // 首次拉取若因未实现或未连接失败，只记录非离线错误，列表自动回退默认快捷键。
      const msg = userFacingMessage(err);
      if (msg && !msg.includes(OFFLINE_MESSAGE) && !msg.includes("样例页")) {
        setActionError(msg);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleSave = useCallback(async (nextRules: KeybindingRule[]) => {
    setBusy(true);
    setActionError(null);
    try {
      await saveKeybindings(nextRules);
    } catch (err) {
      setActionError(userFacingMessage(err) ?? "保存快捷键失败");
    } finally {
      setBusy(false);
    }
  }, []);

  const handleResetAll = useCallback(() => handleSave([]), [handleSave]);

  const handleOpenFile = useCallback(async () => {
    const trimmed = snapshot.path.trim();
    const dir = directoryOf(trimmed);
    const fileName = baseName(trimmed);
    if (!dir || !fileName) return;
    setActionError(null);
    try {
      await openPath(dir, fileName, "default");
    } catch {
      try {
        await revealFolder(dir);
      } catch (err) {
        setActionError(userFacingMessage(err) ?? "打开配置文件失败");
      }
    }
  }, [snapshot.path]);

  return (
    <KeybindingsPanel
      userRules={snapshot.rules}
      configPath={snapshot.path}
      fileError={snapshot.error}
      actionError={actionError}
      busy={busy}
      onSaveRules={handleSave}
      onResetAll={handleResetAll}
      onOpenConfigFile={handleOpenFile}
    />
  );
}
