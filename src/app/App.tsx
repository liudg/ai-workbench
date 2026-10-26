import { useState } from "react";
import { X } from "lucide-react";

import { ProjectList, useProjects } from "@/features/projects";
import { NewTask, TaskView, useAgentProfiles } from "@/features/task";
import { TaskList, useTasks } from "@/features/tasks";
import type { AgentKind } from "@/types";
import { BrandHeader } from "@/shared/brand/BrandHeader";
import { useSidebarOpen } from "@/shared/shell/sidebar-open";
import { ConnectionNotice } from "./ConnectionNotice";
import { useSidebarShortcut } from "./use-sidebar-shortcut";

export default function App() {
  const { projects, loading, error, dismissError, addProject, removeProject } = useProjects();
  const tasksApi = useTasks();
  const profiles = useAgentProfiles();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const task = tasksApi.tasks.find((item) => item.id === selectedTaskId) ?? null;
  const projectId = task?.projectId ?? selectedProjectId;
  const project = projects.find((item) => item.id === projectId) ?? null;
  const visibleTasks = tasksApi.tasks.filter((item) => !item.archivedAt);
  const sidebarOpen = useSidebarOpen();
  useSidebarShortcut();

  return (
    <div className="flex h-full min-h-0 bg-[#0f0f0f] text-[#e8e8e8]">
      <aside
        hidden={!sidebarOpen}
        className="flex h-full min-h-0 w-[260px] shrink-0 flex-col overflow-hidden border-r border-[#222] bg-[#141414]"
      >
        <BrandHeader />
        <ProjectList
          projects={projects}
          loading={loading}
          selectedId={task ? null : (project?.id ?? null)}
          error={error}
          onSelect={(id) => {
            setSelectedProjectId(id);
            setSelectedTaskId(null);
          }}
          onAdd={() => {
            void addProject().then((added) => {
              if (!added) return;
              setSelectedProjectId(added.id);
              setSelectedTaskId(null);
            });
          }}
          onRemove={(id) => void removeProject(id)}
          onDismissError={dismissError}
          renderTasks={(item) => (
            <TaskList
              tasks={visibleTasks.filter((entry) => entry.projectId === item.id)}
              selectedId={selectedTaskId}
              onSelect={setSelectedTaskId}
              onRemove={(entry) => {
                const title = entry.title.trim() || "新任务";
                if (!window.confirm(`删除任务「${title}」和它的对话记录？工作树目录会留在磁盘上。`)) return;
                if (entry.id === selectedTaskId) {
                  setSelectedProjectId(entry.projectId);
                  setSelectedTaskId(null);
                }
                void tasksApi.removeTask(entry.id);
              }}
            />
          )}
        />
        {tasksApi.error && (
          <div className="mx-3 mb-2 flex items-start justify-between gap-2 rounded-lg border border-[#3a2a2a] bg-[#1f1616] px-3 py-2 text-xs text-[#f0c4c4]">
            <span className="min-w-0 break-words">{tasksApi.error}</span>
            <button type="button" aria-label="关闭" className="shrink-0 text-[#a88]" onClick={tasksApi.dismissError}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <ConnectionNotice />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {task && project ? (
          <TaskView task={task} projectPath={project.path} profiles={profiles} />
        ) : project ? (
          <NewTask
            projectId={project.id}
            projectName={project.name}
            agent={project.defaultAgent as AgentKind}
            defaultAccess={profiles[project.defaultAgent as AgentKind]?.default_access}
            onCreate={async (input) => {
              const created = await tasksApi.createTask(input);
              if (created) setSelectedTaskId(created.id);
              return created;
            }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-[#666]">
            {loading ? "" : "选择或添加一个项目"}
          </div>
        )}
      </main>
    </div>
  );
}
