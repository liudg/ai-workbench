import { useEffect, useState } from "react";

import { canChooseApp } from "@/lib/native/open-path";
import { pickFile } from "@/lib/native/pick-files";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { usePanelData, usePanelOptional } from "../core/PanelProvider";
import type { OpenWithAction } from "./open-with";

export function usePickPreviewFile() {
  return async () => {
    try {
      return await pickFile("再打开文件");
    } catch {
      return null;
    }
  };
}

export function useChooseApp(): boolean {
  const [choose, setChoose] = useState(false);
  useEffect(() => {
    // 「用其他应用打开」是桌面版的本机能力。
    let cancel = false;
    void canChooseApp().then(
      (choose) => {
        if (!cancel) setChoose(choose);
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
