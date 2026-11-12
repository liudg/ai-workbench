import { SidebarPlusButton } from "./SidebarPlusButton";
import { useProjectHeader } from "./use-project-header";

export function ProjectHeader() {
  const openDialog = useProjectHeader();

  return (
    <div className="flex items-center justify-between px-2 pb-1 pt-2.5">
      <span className="text-[11px] font-medium tracking-wide text-wb-fg-3">项目</span>
      <SidebarPlusButton label="添加项目" onClick={() => openDialog("import")} />
    </div>
  );
}
