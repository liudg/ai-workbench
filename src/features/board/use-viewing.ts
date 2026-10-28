import { useEffect, useState } from "react";

import { useConnectionStatus } from "@/lib/daemon";
import { useNavigation, visibleTaskOf } from "@/shared/shell/navigation";
import { reportViewing } from "./api";

function windowWatched(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** 窗口在前台、主区摆着某个会话时算在看它。连接重连后 daemon 不记得了，再报一次。应用里调一次。 */
export function useViewingReport() {
  const taskId = useNavigation(visibleTaskOf);
  const status = useConnectionStatus();
  const [watched, setWatched] = useState(windowWatched);

  useEffect(() => {
    const update = () => setWatched(windowWatched());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const viewing = watched ? taskId : null;
  useEffect(() => {
    if (status !== "online") return;
    // 断线时 daemon 那边已经当作没在看，失败不用管。
    void reportViewing(viewing).catch(() => undefined);
  }, [viewing, status]);
}
