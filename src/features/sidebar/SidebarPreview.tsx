import { CommandMenuHost } from "@/features/command-menu/CommandMenuHost";

import { Sidebar } from "./Sidebar";
import { seedSidebarPreview } from "./sidebar-preview-fixture";
import { useSidebarOpen } from "./visibility";

seedSidebarPreview();

export default function SidebarPreview() {
  const open = useSidebarOpen();
  return (
    <div
      data-sidebar-preview=""
      data-sidebar-collapsed={open ? undefined : ""}
      className="flex h-screen w-screen overflow-hidden bg-[#0f0f0f] text-[#e8e8e8]"
    >
      <Sidebar />
      <main className="flex min-w-0 flex-1 items-center justify-center px-8 text-center text-sm leading-6 text-zinc-500">
        从左侧选择一个会话。
      </main>
      <CommandMenuHost />
    </div>
  );
}
