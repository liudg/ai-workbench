import { useCallback, useEffect, useRef, useState } from "react";

import { userFacingMessage } from "@/lib/user-facing";
import type { SessionEvent } from "@/types";
import { activeGoal } from "./goal";
import type { ComposerHost } from "./host";

/** 目标草稿只在提交前占着输入框标志。提交后标志消失，已保存的目标走状态条。 */
export function useGoalDraft(
  host: ComposerHost,
  sessionId: string,
  supportsGoals: boolean,
  events: readonly SessionEvent[],
) {
  const [goalDraft, setGoalDraft] = useState(false);
  const [suppressed, setSuppressed] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const goal = activeGoal(events);
  const objective = goal?.objective ?? "";
  const statusPending = useRef(false);

  useEffect(() => {
    setGoalDraft(false);
    setSuppressed(false);
    setPublishError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!supportsGoals) return;
    let cancel = false;
    void host.publishGoal().catch((error: unknown) => {
      if (!cancel) setPublishError(userFacingMessage(error));
    });
    return () => {
      cancel = true;
    };
  }, [sessionId, supportsGoals]);

  useEffect(() => {
    if (!objective) return;
    setSuppressed(false);
  }, [objective]);

  const enter = useCallback(() => {
    setSuppressed(false);
    setGoalDraft(true);
  }, []);

  const dismiss = useCallback(() => {
    setGoalDraft(false);
    setSuppressed(true);
    if (!objective) return;
    void host.clearGoal().catch((error: unknown) => {
      setSuppressed(false);
      host.reportError(error);
    });
  }, [host, objective]);

  const setStatus = useCallback(
    (status: "paused" | "active") => {
      if (statusPending.current) return;
      statusPending.current = true;
      void (async () => {
        try {
          await host.setGoalStatus(status);
        } catch (error) {
          host.reportError(error);
        } finally {
          statusPending.current = false;
        }
      })();
    },
    [host],
  );

  const submit = useCallback(
    async (text: string) => {
      try {
        await host.setGoal(text);
        setGoalDraft(false);
        return true;
      } catch (error) {
        host.reportError(error);
        return false;
      }
    },
    [host],
  );

  return {
    goalDraft,
    localGoal: goalDraft,
    live: !suppressed && Boolean(objective),
    snapshot: goal,
    publishError,
    enter,
    dismiss,
    setStatus,
    submit,
  };
}
