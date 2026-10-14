import { useEffect } from "react";

import { backend } from "@/lib/ipc";

/** 面板卸下时关掉原生预览 webview。网页预览没有这个子 webview，命令只清主机状态。 */
export function useCloseBrowserOnUnmount() {
  useEffect(() => {
    return () => {
      void backend.browserClose();
    };
  }, []);
}
