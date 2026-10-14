import { AnswerMarkdownHost } from "./AnswerMarkdownHost";
import { ChatView } from "@/features/chat/timeline/ChatView";
import { PanelProvider } from "@/features/panel/core/PanelProvider";
import { SessionSplit } from "@/features/panel/core/SessionSplit";
import { NoProjectSelected, NoSession } from "./empty/EmptyState";
import { useWorkspace } from "./use-workspace";

export function Workspace() {
  const { project, sessions, session, events, usage } = useWorkspace();

  if (!project) return <NoProjectSelected />;

  if (session) {
    return (
      <PanelProvider
        sessionId={session.id}
        projectId={project.id}
        projectPath={project.path}
        sessionTitle={session.title}
        agent={session.agent}
        events={events}
        usage={usage}
      >
        <AnswerMarkdownHost>
          <SessionSplit>
            <ChatView session={session} events={events} />
          </SessionSplit>
        </AnswerMarkdownHost>
      </PanelProvider>
    );
  }

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      {sessions && sessions.length > 0 ? (
        <div className="flex h-full items-center justify-center px-8 text-center text-sm leading-6 text-zinc-500">
          从左侧选择一个会话。
        </div>
      ) : sessions ? (
        <NoSession projectId={project.id} />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-zinc-600">
          加载中…
        </div>
      )}
    </div>
  );
}
