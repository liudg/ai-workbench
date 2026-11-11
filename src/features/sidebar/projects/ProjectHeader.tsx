import { SidebarPlusButton } from "./SidebarPlusButton";
import { useProjectHeader } from "./use-project-header";

export function ProjectHeader() {
  const openDialog = useProjectHeader();

  return (
    <div className="flex items-center justify-between px-2.5 pb-1 pt-2.5">
      <span className="text-[11px] font-semibold tracking-[0.04em] text-[var(--wb-faint)]">项目</span>
      <div className="flex items-center gap-0.5">
        <SidebarPlusButton label="创建项目" onClick={() => openDialog("create")} />
      </div>
    </div>
  );
}
