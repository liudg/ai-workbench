import { SidebarPlusButton } from "./SidebarPlusButton";
import { useProjectHeader } from "./use-project-header";

export function ProjectHeader() {
  const openDialog = useProjectHeader();

  return (
    <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5">
      <span className="wb-group-header min-w-0 flex-1">项目</span>
      <SidebarPlusButton label="添加项目" onClick={() => openDialog("import")} />
    </div>
  );
}
