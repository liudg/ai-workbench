import { NoProjectSelected } from "./empty/EmptyState";
import { NewSessionView } from "./new/NewSessionView";
import { SessionView } from "./session/SessionView";
import { SettingsView } from "./settings/SettingsView";
import { useWorkspace } from "./use-workspace";

export function Workspace() {
  const { settings, view, projects, project, task, taskSession, loading } = useWorkspace();

  if (settings) return <SettingsView />;
  if (view.kind === "task") {
    if (task && taskSession) {
      return <SessionView key={task.id} task={task} taskSession={taskSession} project={project} />;
    }
    return loading ? null : <NoProjectSelected />;
  }
  if (view.kind === "new") {
    if (view.projectId && !project) return loading ? null : <NoProjectSelected />;
    return <NewSessionView projectId={view.projectId} project={project} projects={projects} />;
  }
  return <NoProjectSelected />;
}
