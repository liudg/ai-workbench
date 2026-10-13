import { useWorkbench } from "@/store";

export function useSidebar() {
  const projects = useWorkbench((s) => s.projects);
  const notice = useWorkbench((s) => s.sidebarNotice);
  return { projects, notice };
}
