import { Sidebar } from "./Sidebar";
import { seedSidebarPreview } from "./sidebar-preview-fixture";

seedSidebarPreview();

export default function SidebarPreview() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0f0f0f] text-[#e8e8e8]">
      <Sidebar />
      <main className="min-w-0 flex-1" />
    </div>
  );
}
