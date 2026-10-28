import { useEffect } from "react";

import { isTauri } from "@/lib/daemon/endpoint";
import { browserClose } from "@/lib/native/browser";

/** 面板卸下时关掉原生预览 webview。网页预览没有这个子 webview，不用关。 */
export function useCloseBrowserOnUnmount() {
  useEffect(() => {
    return () => {
      if (isTauri) void browserClose();
    };
  }, []);
}
