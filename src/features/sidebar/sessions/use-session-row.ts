import { useWorkbench } from "@/store";
import { isFinishedStatus } from "@/store/unread-finished";
import type { Session } from "@/types";
import { agentIdentity } from "./agent-identity";

export function useSessionRow(session: Session) {
  const selectSession = useWorkbench((s) => s.selectSession);
  const profile = useWorkbench((s) => s.profiles[session.agent]);
  const caps = profile?.kind === session.agent ? profile.capabilities : undefined;
  const identity = agentIdentity(session.agent, profile);
  const busy = useWorkbench((s) => s.lifecycleBusy === session.id);
  const renameSession = useWorkbench((s) => s.renameSession);
  const forkSession = useWorkbench((s) => s.forkSession);
  const deleteSession = useWorkbench((s) => s.deleteSession);
  const unreadFinished = useWorkbench(
    (s) => s.unreadFinishedIds.includes(session.id) && isFinishedStatus(session.status),
  );
  return {
    selectSession,
    caps,
    identity,
    busy,
    renameSession,
    forkSession,
    deleteSession,
    unreadFinished,
  };
}
