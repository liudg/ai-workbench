import { useShallow } from "zustand/react/shallow";

import { sessionCatalog } from "@/lib/catalog";
import { useWorkbench } from "@/store";
import type { AgentKind, Attachment, QueuedTurn } from "@/types";

const EMPTY_FILES: Attachment[] = [];
const EMPTY_QUEUE: QueuedTurn[] = [];

export function useComposerActions() {
  return useWorkbench(
    useShallow((state) => ({
      sendMessage: state.sendMessage,
      setCollaborationMode: state.setCollaborationMode,
      startReview: state.startReview,
      answerPrompt: state.answerPrompt,
      setSandbox: state.setSandbox,
      loadCatalog: state.loadCatalog,
      setTuning: state.setTuning,
      addAttachments: state.addAttachments,
      removeAttachment: state.removeAttachment,
      clearAttachments: state.clearAttachments,
      replaceAttachments: state.replaceAttachments,
    })),
  );
}

export function useComposerSession(session: { id: string; agent: AgentKind; project_id: string }) {
  return useWorkbench(
    useShallow((state) => ({
      catalog: sessionCatalog(state.catalogs, session.id),
      catalogNotice: state.catalogNotices[session.id] ?? null,
      profile: state.profiles[session.agent],
      tuning: state.tuning[session.id],
      sandbox: state.sandboxes[session.id] ?? null,
      projectPath: state.projects.find((project) => project.id === session.project_id)?.path ?? "",
      files: state.attachments[session.id] ?? EMPTY_FILES,
      queue: state.queues[session.id] ?? EMPTY_QUEUE,
    })),
  );
}
