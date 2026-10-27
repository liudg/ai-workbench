import { useEffect, useState } from "react";

import { backend, isTauri } from "@/lib/ipc";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { usePanelData, usePanelOptional } from "../core/PanelProvider";
import type { OpenWithAction } from "./open-with";

export function usePickPreviewFile() {
  return async () => {
    try {
      return await backend.pickPreviewFile();
    } catch {
      return null;
    }
  };
}

export function useChooseApp(): boolean {
  const [choose, setChoose] = useState(false);
  useEffect(() => {
    // 「用其他应用打开」是桌面版的本机能力。
    if (!isTauri) return;
    let cancel = false;
    void backend.fileOpenCapabilities().then(
      (caps) => {
        if (!cancel) setChoose(Boolean(caps.choose_app));
      },
      () => {
        if (!cancel) setChoose(false);
      },
    );
    return () => {
      cancel = true;
    };
  }, []);
  return choose;
}

export function useOpenProjectFile(projectId: string, sessionId?: string) {
  const panelSessionId = usePanelOptional()?.sessionId;
  const resolvedSessionId = sessionId || panelSessionId || "";
  const data = usePanelData();
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(""), 1500);
    return () => window.clearTimeout(timer);
  }, [note]);

  const openWith = async (path: string, mode: OpenWithAction) => {
    if (!projectId || !path) return;
    try {
      await data.openFile(projectId, path, mode, resolvedSessionId);
      setNote("");
    } catch (err) {
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
      setNote(message.trim() || DESKTOP_ZH.openFileFailed);
    }
  };

  return { note, openWith };
}
