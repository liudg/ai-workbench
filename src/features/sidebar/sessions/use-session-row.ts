import { loadWorktreeDeletePreview } from "@/lib/worktree-delete-preview";
import { useWorkbench } from "@/store";
import { isFinishedStatus } from "@/store/unread-finished";
import type { Session } from "@/types";
import { agentIdentity } from "@/shared/agent/identity";

export function useSessionRow(session: Session) {
  const selectSession = useWorkbench((s) => s.selectSession);
  const profile = useWorkbench((s) => s.profiles[session.agent]);
  const caps = profile?.kind === session.agent ? profile.capabilities : undefined;
  const identity = agentIdentity(session.agent, profile);
  const busy = useWorkbench((s) => s.lifecycleBusy === session.id);
  const pinned = useWorkbench((s) => s.pinnedSessionIds.includes(session.id));
  const renameSession = useWorkbench((s) => s.renameSession);
  const togglePinnedSession = useWorkbench((s) => s.togglePinnedSession);
  const archiveSession = useWorkbench((s) => s.archiveSession);
  const deleteSession = useWorkbench((s) => s.deleteSession);
  const unreadFinished = useWorkbench(
    (s) => s.unreadFinishedIds.includes(session.id) && isFinishedStatus(session.status),
  );
  const previewWorktreeDelete = () => loadWorktreeDeletePreview(session.id);
  return {
    selectSession,
    caps,
    identity,
    busy,
    pinned,
    renameSession,
    togglePinnedSession,
    archiveSession,
    deleteSession,
    unreadFinished,
    previewWorktreeDelete,
  };
}
