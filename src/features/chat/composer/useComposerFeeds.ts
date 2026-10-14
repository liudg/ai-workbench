import { useEffect, useState } from "react";

import type { PermissionMenu } from "@/types";
import { fetchPermissionMenu, fetchQueue, storeQueue } from "./composer-backend";

export function useComposerFeeds(
  sessionId: string,
  loadCatalog: (sessionId: string) => void,
) {
  const [permissionMenu, setPermissionMenu] = useState<PermissionMenu | null>(null);

  useEffect(() => {
    void loadCatalog(sessionId);
  }, [loadCatalog, sessionId]);

  useEffect(() => {
    let cancelled = false;
    void fetchQueue(sessionId)
      .then((items) => {
        if (!cancelled) storeQueue(sessionId, items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    void fetchPermissionMenu(sessionId)
      .then((next) => {
        if (!cancelled) setPermissionMenu(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return permissionMenu;
}
