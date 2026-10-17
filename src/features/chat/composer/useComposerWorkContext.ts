import { useWorkbench } from "@/store";
import { isDraftId } from "@/store/draft-session";
import {
  composerShowsWorkContext,
  hasUserMessage,
  isStandaloneDraft,
  STANDALONE_DRAFT_ID,
  visibleProjects,
} from "@/store/standalone";
import type { Session, SessionEvent } from "@/types";

/**
 * 空会话输入框上方的项目选择。
 * 第一条用户消息出现后消失。创建中的草稿不能改项目。
 */
/** 作曲栏上的 git 分支只属于真正的项目，独立聊天不显示。 */
export function useComposerGitProject(session: Session): { id: string; name: string } | null {
  const projects = useWorkbench((s) => s.projects);
  const project = projects.find((item) => item.id === session.project_id);
  if (!project || project.standalone) return null;
  return { id: project.id, name: project.name };
}

export function useComposerWorkContext(
  session: Session,
  events: readonly SessionEvent[],
  inputLocked: boolean,
) {
  const retargetDraft = useWorkbench((s) => s.retargetDraft);
  const workProjects = useWorkbench((s) => s.projects);
  const eventsLoaded = useWorkbench((s) => Boolean(s.eventsReady[session.id]));
  const draftSession = isDraftId(session.id);
  const currentProject = workProjects.find((project) => project.id === session.project_id);
  const standalone = isStandaloneDraft(session.project_id) || Boolean(currentProject?.standalone);
  if (
    !composerShowsWorkContext({
      draft: draftSession,
      eventsLoaded,
      hasUserMessage: hasUserMessage(events),
    })
  ) {
    return null;
  }
  return {
    label: standalone ? "聊天" : (currentProject?.name ?? "聊天"),
    projects: visibleProjects(workProjects).map((project) => ({
      id: project.id,
      name: project.name,
    })),
    selectedId: standalone ? STANDALONE_DRAFT_ID : session.project_id,
    standaloneId: STANDALONE_DRAFT_ID,
    canRetarget: draftSession && !inputLocked,
    onPickProject: (projectId: string) => retargetDraft(session.project_id, projectId),
    onPickStandalone: () => retargetDraft(session.project_id, STANDALONE_DRAFT_ID),
  };
}
