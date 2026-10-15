import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionEvent } from "@/types";
import {
  clearThreadGoal,
  publishThreadGoal,
  reportComposerError,
  setThreadGoal,
  setThreadGoalStatus,
} from "./composer-backend";
import { activeGoal } from "./goal";

/** 目标芯片：提交前是本地草稿，提交后跟 `thread/goal` 事件。 */
export function useGoalDraft(sessionId: string, supportsGoals: boolean, events: readonly SessionEvent[]) {
  const [goalDraft, setGoalDraft] = useState(false);
  const [goalPinned, setGoalPinned] = useState(false);
  const [suppressed, setSuppressed] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const goal = activeGoal(events);
  const objective = goal?.objective ?? "";
  const statusPending = useRef(false);

  useEffect(() => {
    setGoalDraft(false);
    setGoalPinned(false);
    setSuppressed(false);
    setPublishError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!supportsGoals) return;
    let cancel = false;
    void publishThreadGoal(sessionId).catch((error: unknown) => {
      if (!cancel) setPublishError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancel = true;
    };
  }, [sessionId, supportsGoals]);

  useEffect(() => {
    if (!objective) return;
    setGoalPinned(false);
    setSuppressed(false);
  }, [objective]);

  const enter = useCallback(() => {
    setSuppressed(false);
    setGoalDraft(true);
  }, []);

  const dismiss = useCallback(() => {
    const shouldClear = Boolean(objective) || goalPinned;
    setGoalDraft(false);
    setGoalPinned(false);
    setSuppressed(true);
    if (!shouldClear) return;
    void clearThreadGoal(sessionId).catch((error: unknown) => {
      setSuppressed(false);
      reportComposerError(sessionId, error);
    });
  }, [goalPinned, objective, sessionId]);

  const setStatus = useCallback(
    (status: "paused" | "active") => {
      if (statusPending.current) return;
      statusPending.current = true;
      void (async () => {
        try {
          await setThreadGoalStatus(sessionId, status);
        } catch (error) {
          reportComposerError(sessionId, error);
        } finally {
          statusPending.current = false;
        }
      })();
    },
    [sessionId],
  );

  const submit = useCallback(
    async (text: string) => {
      try {
        await setThreadGoal(sessionId, text);
        setGoalDraft(false);
        setGoalPinned(true);
        return true;
      } catch (error) {
        reportComposerError(sessionId, error);
        return false;
      }
    },
    [sessionId],
  );

  return {
    goalDraft,
    localGoal: goalDraft || goalPinned,
    live: !suppressed && Boolean(objective),
    snapshot: goal,
    publishError,
    enter,
    dismiss,
    setStatus,
    submit,
  };
}
