import { CommandMenuHost } from "@/features/command-menu";

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
      className="flex h-screen w-screen overflow-hidden bg-[var(--wb-shell)] text-[var(--wb-text)]"
    >
      <Sidebar />
      <main className="m-2 flex min-w-0 flex-1 items-center justify-center rounded-2xl border border-[var(--wb-border)] bg-[var(--wb-canvas)] px-8 text-center text-sm leading-6 text-[var(--wb-muted)] shadow-[var(--wb-sheet-shadow)]">
        从左侧选择一个会话。
      </main>
      <CommandMenuHost />
    </div>
  );
}
