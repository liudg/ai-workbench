import { useState } from "react";

import { ProjectList, useProjects } from "@/features/projects";
import { BrandHeader } from "@/shared/brand/BrandHeader";
import { ConnectionNotice } from "./ConnectionNotice";

export default function App() {
  const { projects, loading, error, dismissError, addProject, removeProject } = useProjects();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = projects.find((project) => project.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 bg-[#0f0f0f] text-[#e8e8e8]">
      <aside className="flex h-full min-h-0 w-[260px] shrink-0 flex-col overflow-hidden border-r border-[#222] bg-[#141414]">
        <BrandHeader />
        <ProjectList
          projects={projects}
          loading={loading}
          selectedId={selected?.id ?? null}
          error={error}
          onSelect={setSelectedId}
          onAdd={() => {
            void addProject().then((project) => {
              if (project) setSelectedId(project.id);
            });
          }}
          onRemove={(id) => void removeProject(id)}
          onDismissError={dismissError}
        />
        <ConnectionNotice />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <header className="border-b border-[#222] px-5 py-3">
              <h1 className="truncate text-[14px] font-medium">{selected.name}</h1>
              <p className="truncate text-[12px] text-[#888]">{selected.path}</p>
            </header>
            <div className="flex flex-1 items-center justify-center text-[13px] text-[#666]">还没有任务</div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-[#666]">
            {loading ? "" : "选择或添加一个项目"}
          </div>
        )}
      </main>
    </div>
  );
}
