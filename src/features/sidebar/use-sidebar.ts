import { useMemo } from "react";

import { useWorkbench } from "@/store";
import { visibleProjects } from "@/store/standalone";

export function useSidebar() {
  const all = useWorkbench((s) => s.projects);
  const projects = useMemo(() => visibleProjects(all), [all]);
  const notice = useWorkbench((s) => s.sidebarNotice);
  return { projects, notice };
}
