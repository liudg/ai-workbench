import { CommandMenuHost } from "@/features/command-menu";
import { cn } from "@/lib/utils";

import { Sidebar } from "./Sidebar";
import { seedSidebarPreview } from "./sidebar-preview-fixture";
import { useSidebarOpen } from "@/shared/shell/sidebar-open";

seedSidebarPreview();

export default function SidebarPreview() {
  const open = useSidebarOpen();
  return (
    <div
      data-sidebar-preview=""
      data-sidebar-collapsed={open ? undefined : ""}
      className="flex h-screen w-screen overflow-hidden bg-wb-shell text-wb-fg"
    >
      <Sidebar />
      <main
        className={cn(
          "my-2 mr-2 flex min-w-0 flex-1 items-center justify-center rounded-xl border border-wb-border bg-wb-surface px-8 text-center text-sm leading-6 text-wb-fg-3 shadow-[var(--wb-island-shadow)]",
          !open && "ml-2",
        )}
      >
        从左侧选择一个会话。
      </main>
      <CommandMenuHost />
    </div>
  );
}
