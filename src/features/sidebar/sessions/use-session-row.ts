import { useWorkbench } from "@/store";
import type { Session } from "@/types";

export function useSessionRow(session: Session) {
  const selectSession = useWorkbench((s) => s.selectSession);
  const caps = useWorkbench((s) => s.profiles[session.agent]?.capabilities);
  const busy = useWorkbench((s) => s.lifecycleBusy === session.id);
  const renameSession = useWorkbench((s) => s.renameSession);
  const forkSession = useWorkbench((s) => s.forkSession);
  const deleteSession = useWorkbench((s) => s.deleteSession);
  return { selectSession, caps, busy, renameSession, forkSession, deleteSession };
}
