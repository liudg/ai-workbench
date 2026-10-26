import { SidebarPlusButton } from "./SidebarPlusButton";
import { useProjectHeader } from "./use-project-header";

export function ProjectHeader() {
  const openDialog = useProjectHeader();

  return (
    <div className="flex items-center justify-between px-3 pb-1.5 pt-2.5">
      <span className="text-[12px] text-[#cfcfcf]">项目</span>
      <SidebarPlusButton label="创建项目" onClick={() => openDialog("create")} />
    </div>
  );
}
