import { useMemo } from "react";

import { useWorkbench } from "@/store";
import { visibleProjects } from "@/store/standalone";
import { splitPinnedProjects } from "./projects/project-sections";

export function useSidebar() {
  const all = useWorkbench((s) => s.projects);
  const pinnedIds = useWorkbench((s) => s.pinnedProjectIds);
  const projects = useMemo(() => visibleProjects(all), [all]);
  const sections = useMemo(
    () => splitPinnedProjects(projects, pinnedIds),
    [projects, pinnedIds],
  );
  const notice = useWorkbench((s) => s.sidebarNotice);
  return { pinned: sections.pinned, unpinned: sections.unpinned, notice };
}
