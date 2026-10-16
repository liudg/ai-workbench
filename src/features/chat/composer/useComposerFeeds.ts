import { useEffect, useState } from "react";

import { useWorkbench } from "@/store";
import { isDraftId } from "@/store/draft-session";
import type { AgentKind, PermissionMenu } from "@/types";
import { fetchDraftPermissionMenu, fetchPermissionMenu, fetchQueue, storeQueue } from "./composer-backend";
import { queueFetchStillCurrent } from "./queue-strip";

export function useComposerFeeds(
  sessionId: string,
  agent: AgentKind,
  loadCatalog: (sessionId: string) => void,
) {
  const [permissionMenu, setPermissionMenu] = useState<PermissionMenu | null>(null);
  const draft = isDraftId(sessionId);

  useEffect(() => {
    void loadCatalog(sessionId);
  }, [agent, loadCatalog, sessionId]);

  useEffect(() => {
    if (draft) return;
    let cancelled = false;
    const before = useWorkbench.getState().queues[sessionId];
    void fetchQueue(sessionId)
      .then((items) => {
        if (cancelled) return;
        const current = useWorkbench.getState().queues[sessionId];
        if (!queueFetchStillCurrent(before, current)) return;
        storeQueue(sessionId, items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [draft, sessionId]);

  useEffect(() => {
    let cancelled = false;
    const load = draft ? fetchDraftPermissionMenu(agent) : fetchPermissionMenu(sessionId);
    void load
      .then((next) => {
        if (!cancelled) setPermissionMenu(next);
      })
      .catch(() => {
        if (!cancelled) setPermissionMenu(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agent, draft, sessionId]);

  return permissionMenu;
}
