import { Sidebar } from "@/features/sidebar";
import { Workspace } from "@/features/workspace/Workspace";

import { useWorkContextPreview } from "./use-work-context-preview";

/** 开发预览。`?preview=work-context`，`scene=fresh|project|empty|sent|cleared|choose|none`。不另开工作台窗口。 */
export default function WorkContextPreview() {
  useWorkContextPreview();
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--wb-shell)] text-[var(--wb-text)]">
      <Sidebar />
      <main className="my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--wb-border)] bg-[var(--wb-canvas)] shadow-[var(--wb-sheet-shadow)]">
        <Workspace />
      </main>
    </div>
  );
}
