import type { ReactNode } from "react";

import { BoardView } from "@/features/board";
import { CommandMenuHost } from "@/features/command-menu";
import { NoProjectSelected } from "./empty/EmptyState";
import { NewSessionView } from "./new/NewSessionView";
import { SessionView } from "./session/SessionView";
import { SettingsView } from "@/features/settings";
import { useWorkspace } from "./use-workspace";

export function Workspace() {
  const { settings, board, view, projects, project, task, taskSession, loading } = useWorkspace();

  if (settings) return <WithMenu><SettingsView /></WithMenu>;
  if (board) return <WithMenu><BoardView /></WithMenu>;
  if (view.kind === "task") {
    if (task && taskSession) {
      return <SessionView key={task.id} task={task} taskSession={taskSession} project={project} />;
    }
    return loading ? null : <WithMenu><NoProjectSelected /></WithMenu>;
  }
  if (view.kind === "new") {
    if (view.projectId && !project) return loading ? null : <WithMenu><NoProjectSelected /></WithMenu>;
    return <NewSessionView projectId={view.projectId} project={project} projects={projects} />;
  }
  return (
    <WithMenu>
      <NoProjectSelected />
    </WithMenu>
  );
}

/** 会话视图把命令菜单挂在自己的面板里；其他页面在这里挂。 */
function WithMenu({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <CommandMenuHost />
    </>
  );
}
