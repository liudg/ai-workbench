import { X } from "lucide-react";

import { NewProjectDialog, Sidebar } from "@/features/sidebar";
import { UpdateDialog, useStartupUpdateCheck } from "@/features/updates";
import { Workspace } from "@/features/workspace";
import { clearError, useErrorBanner } from "@/shared/shell/error-banner";
import { useSidebarShortcut } from "./use-sidebar-shortcut";

export default function App() {
  const error = useErrorBanner();
  useSidebarShortcut();
  useStartupUpdateCheck();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0f0f0f] text-[#e8e8e8]">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div className="flex items-start gap-3 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">
            <p className="min-w-0 flex-1">{error}</p>
            <button
              type="button"
              aria-label="关闭"
              className="shrink-0 text-red-300 hover:text-white"
              onClick={clearError}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <Workspace />
      </main>
      <NewProjectDialog />
      <UpdateDialog />
    </div>
  );
}
