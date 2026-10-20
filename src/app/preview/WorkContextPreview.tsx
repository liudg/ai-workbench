import { Sidebar } from "@/features/sidebar";
import { Workspace } from "@/features/workspace/Workspace";

import { useWorkContextPreview } from "./use-work-context-preview";

/** 开发预览。`?preview=work-context`，`scene=fresh|project|empty|sent|cleared|choose|none`。不另开工作台窗口。 */
export default function WorkContextPreview() {
  useWorkContextPreview();
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0f0f0f] text-[#e8e8e8]">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Workspace />
      </main>
    </div>
  );
}
