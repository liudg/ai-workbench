import { Sidebar } from "@/features/sidebar";
import { Workspace } from "@/features/workspace";
import { cn } from "@/lib/utils";
import { useSidebarOpen } from "@/shared/shell/sidebar-open";

import { useWorkContextPreview } from "./use-work-context-preview";

/** 开发预览。`?preview=work-context`，`scene=fresh|project|none`。不连后台服务。 */
export default function WorkContextPreview() {
  const open = useSidebarOpen();
  useWorkContextPreview();
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-wb-shell text-wb-fg">
      <Sidebar />
      <main
        className={cn(
          "my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-wb-border bg-wb-surface shadow-[var(--wb-island-shadow)]",
          !open && "ml-2",
        )}
      >
        <Workspace />
      </main>
    </div>
  );
}
